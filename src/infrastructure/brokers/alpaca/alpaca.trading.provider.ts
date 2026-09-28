import { AxiosError } from "axios";
import { z } from "zod";
import type { BrokerConfig } from "@/config/broker.config.js";
import type {
  BrokerAccount,
  BrokerAsset,
  BrokerContext,
  BrokerOrder,
  BrokerProvider,
  MarketClock,
  NotionalOrderRequest
} from "@/ports/broker.port.js";
import { BrokerError } from "@/ports/broker.errors.js";
import { alpacaHttp, toBrokerError } from "./alpaca.http.js";
import {
  alpacaAsset,
  alpacaClock,
  alpacaOrder,
  toBrokerAsset,
  toBrokerOrder,
  toMarketClock
} from "./alpaca.mapper.js";

/**
 * `GET /v2/account`, réduit aux champs dont AMARA a besoin.
 *
 * Les montants arrivent en chaînes chez Alpaca, et restent des chaînes :
 * les convertir en `number` ici réintroduirait l'imprécision que tout le
 * reste de la chaîne évite.
 */
const alpacaAccount = z.object({
  id: z.string().min(1),
  account_number: z.string().min(1),
  status: z.string(),
  currency: z.string().default("USD"),
  cash: z.string(),
  buying_power: z.string(),
  trading_blocked: z.boolean().default(false),
  account_blocked: z.boolean().default(false),
  trade_suspended_by_user: z.boolean().default(false)
});

function unexpected(operation: string): BrokerError {
  console.warn(`[alpaca] ${operation} : réponse inattendue`);
  return new BrokerError(
    "BROKER_REQUEST_FAILED",
    "Réponse inattendue d’Alpaca.",
    502
  );
}

function isNotFound(error: unknown): boolean {
  return (error as AxiosError)?.response?.status === 404;
}

/**
 * Fournisseur Alpaca Trading API, authentifié par le jeton OAuth de
 * l'utilisateur.
 *
 * Seul endroit du code qui connaît les chemins `/v2/…` et les deux URL de
 * base. Le choix entre paper et live vient du contexte, jamais d'une valeur
 * par défaut : un jeton envoyé au mauvais environnement doit échouer, pas
 * trader ailleurs que prévu.
 */
export class AlpacaTradingProvider implements BrokerProvider {
  constructor(private readonly config: BrokerConfig) {}

  private url(context: BrokerContext, path: string): string {
    return `${this.config.apiUrl[context.environment]}${path}`;
  }

  private auth(context: BrokerContext) {
    return { Authorization: `Bearer ${context.accessToken}` };
  }

  private async read<T>(
    context: BrokerContext,
    path: string,
    operation: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>
  ): Promise<T | null> {
    let data: unknown;

    try {
      const response = await alpacaHttp.get(this.url(context, path), {
        headers: this.auth(context),
        params
      });
      data = response.data;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw toBrokerError(error, operation);
    }

    const parsed = schema.safeParse(data);
    if (!parsed.success) throw unexpected(operation);
    return parsed.data;
  }

  async getAccount(context: BrokerContext): Promise<BrokerAccount> {
    const account = await this.read(context, "/v2/account", "lecture du compte", alpacaAccount);
    if (!account) throw unexpected("lecture du compte");

    return {
      externalId: account.id,
      accountNumber: account.account_number,
      status: account.status,
      canTrade:
        account.status === "ACTIVE" &&
        !account.trading_blocked &&
        !account.account_blocked &&
        !account.trade_suspended_by_user,
      currency: account.currency,
      cash: account.cash,
      buyingPower: account.buying_power
    };
  }

  async getAsset(context: BrokerContext, symbol: string): Promise<BrokerAsset | null> {
    const asset = await this.read(
      context,
      `/v2/assets/${encodeURIComponent(symbol)}`,
      "lecture d'un actif",
      alpacaAsset
    );
    return asset ? toBrokerAsset(asset) : null;
  }

  async getClock(context: BrokerContext): Promise<MarketClock> {
    const clock = await this.read(context, "/v2/clock", "horloge de marché", alpacaClock);
    if (!clock) throw unexpected("horloge de marché");
    return toMarketClock(clock);
  }

  async placeNotionalOrder(
    context: BrokerContext,
    request: NotionalOrderRequest
  ): Promise<BrokerOrder> {
    let data: unknown;

    try {
      const response = await alpacaHttp.post(
        this.url(context, "/v2/orders"),
        {
          symbol: request.symbol,
          notional: request.notional,
          side: request.side === "BUY" ? "buy" : "sell",
          // Imposés par Alpaca pour un ordre en montant.
          type: "market",
          time_in_force: "day",
          client_order_id: request.clientOrderId
        },
        { headers: { ...this.auth(context), "Content-Type": "application/json" } }
      );
      data = response.data;
    } catch (error) {
      // 403 = refus métier (pouvoir d'achat), PAS une révocation.
      throw toBrokerError(error, "transmission d'un ordre", { forbidden: "rejected" });
    }

    const parsed = alpacaOrder.safeParse(data);
    if (!parsed.success) {
      /*
       * L'ordre est très probablement parti — Alpaca a répondu 2xx. Lever
       * `BROKER_UNAVAILABLE` range ce cas parmi les issues inconnues : le
       * service le retrouvera par sa clé au lieu de le déclarer échoué.
       */
      console.warn("[alpaca] transmission d'un ordre : réponse 2xx illisible");
      throw new BrokerError(
        "BROKER_UNAVAILABLE",
        "Confirmation d’Alpaca illisible.",
        503
      );
    }

    return toBrokerOrder(parsed.data);
  }

  async getOrder(context: BrokerContext, externalId: string): Promise<BrokerOrder | null> {
    const order = await this.read(
      context,
      `/v2/orders/${encodeURIComponent(externalId)}`,
      "lecture d'un ordre",
      alpacaOrder
    );
    return order ? toBrokerOrder(order) : null;
  }

  async findOrderByClientOrderId(
    context: BrokerContext,
    clientOrderId: string
  ): Promise<BrokerOrder | null> {
    const order = await this.read(
      context,
      "/v2/orders:by_client_order_id",
      "recherche d'un ordre par clé",
      alpacaOrder,
      { client_order_id: clientOrderId }
    );
    return order ? toBrokerOrder(order) : null;
  }
}
