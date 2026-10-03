import { AxiosError } from "axios";
import { z } from "zod";
import type { BrokerConfig } from "@/config/broker.config.js";
import type {
  BrokerAccount,
  BrokerAsset,
  BrokerContext,
  BrokerOrder,
  BrokerPosition,
  BrokerProvider,
  HistoryRange,
  MarketClock,
  MarketSnapshot,
  NewsArticle,
  NotionalOrderRequest,
  SeriesPoint
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
  equity: z.string().default("0"),
  last_equity: z.string().default("0"),
  trading_blocked: z.boolean().default(false),
  account_blocked: z.boolean().default(false),
  trade_suspended_by_user: z.boolean().default(false)
});

const alpacaPositions = z.array(
  z.object({
    symbol: z.string(),
    qty: z.string(),
    avg_entry_price: z.string(),
    current_price: z.string().nullable().default("0"),
    market_value: z.string().nullable().default("0"),
    cost_basis: z.string(),
    unrealized_pl: z.string().nullable().default("0"),
    unrealized_plpc: z.string().nullable().default("0"),
    change_today: z.string().nullable().default("0")
  })
);

const alpacaHistory = z.object({
  timestamp: z.array(z.number()).default([]),
  equity: z.array(z.number().nullable()).default([])
});

const bar = z.object({ t: z.string(), c: z.number() });
const alpacaBars = z.object({ bars: z.array(bar).nullable().default([]) });

const alpacaSnapshots = z.record(
  z.string(),
  z
    .object({
      latestTrade: z.object({ p: z.number(), t: z.string() }).nullable().optional(),
      dailyBar: bar.nullable().optional(),
      prevDailyBar: bar.nullable().optional()
    })
    .nullable()
);

const alpacaNews = z.object({
  news: z.array(
    z.object({
      id: z.number(),
      headline: z.string(),
      source: z.string().default(""),
      url: z.string().nullable().optional(),
      created_at: z.string(),
      symbols: z.array(z.string()).default([])
    })
  )
});

/** Ratio Alpaca (0.0412) → pourcentage affichable ("4.12"). */
function ratioToPercent(ratio: string | null): string {
  const value = Number(ratio ?? 0);
  return Number.isFinite(value) ? (value * 100).toFixed(2) : "0";
}

const DAY_MS = 86_400_000;

/**
 * Pas et profondeur de chaque période.
 *
 * Données « SIP » (toutes les places américaines) : le forfait gratuit les
 * sert avec 15 minutes de retard, d'où `end` décalé. Le cours du moment vient
 * des instantanés, en flux IEX temps réel.
 */
const BAR_RANGES: Record<HistoryRange, { timeframe: string; days: number }> = {
  "1J": { timeframe: "5Min", days: 5 },
  "1S": { timeframe: "1Hour", days: 7 },
  "1M": { timeframe: "1Day", days: 31 },
  "3M": { timeframe: "1Day", days: 92 },
  "1A": { timeframe: "1Day", days: 366 },
  TOUT: { timeframe: "1Month", days: 365 * 15 }
};

const HISTORY_RANGES: Record<HistoryRange, { period: string; timeframe: string }> = {
  "1J": { period: "1D", timeframe: "5Min" },
  "1S": { period: "1W", timeframe: "1H" },
  "1M": { period: "1M", timeframe: "1D" },
  "3M": { period: "3M", timeframe: "1D" },
  "1A": { period: "1A", timeframe: "1D" },
  TOUT: { period: "all", timeframe: "1D" }
};

/** Heure de New York d'un horodatage, en minutes depuis minuit. */
const nyClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
function nyMinutes(iso: string): number {
  const [h, m] = nyClock.format(new Date(iso)).split(":").map(Number);
  return h * 60 + m;
}

/** Ne garde que la dernière séance régulière (9 h 30 – 16 h, New York). */
function lastRegularSession(bars: { t: string; c: number }[]) {
  const regular = bars.filter((b) => {
    const minutes = nyMinutes(b.t);
    return minutes >= 570 && minutes < 960;
  });
  const lastDay = regular.at(-1)?.t.slice(0, 10);
  return regular.filter((b) => b.t.slice(0, 10) === lastDay);
}

/**
 * Clés API du compte partagé (ID + secret), transportées dans
 * `BrokerContext.accessToken` à la place d'un jeton OAuth. Alpaca les
 * attend en en-têtes `APCA-API-*`, pas en `Bearer`.
 */
const API_KEY_PREFIX = "apca-key:";

export function apiKeyCredential(keyId: string, secret: string): string {
  return `${API_KEY_PREFIX}${keyId}:${secret}`;
}

function authHeaders(credential: string): Record<string, string> {
  if (!credential.startsWith(API_KEY_PREFIX)) {
    return { Authorization: `Bearer ${credential}` };
  }
  const rest = credential.slice(API_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  return {
    "APCA-API-KEY-ID": rest.slice(0, separator),
    "APCA-API-SECRET-KEY": rest.slice(separator + 1)
  };
}

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
    return authHeaders(context.accessToken);
  }

  private read<T>(
    context: BrokerContext,
    path: string,
    operation: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>
  ): Promise<T | null> {
    return this.get(context, this.url(context, path), operation, schema, params);
  }

  /** Lecture sur l'API de données de marché. */
  private readData<T>(
    context: BrokerContext,
    path: string,
    operation: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>
  ): Promise<T | null> {
    return this.get(context, `${this.config.dataUrl}${path}`, operation, schema, params);
  }

  private async get<T>(
    context: BrokerContext,
    url: string,
    operation: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>
  ): Promise<T | null> {
    let data: unknown;

    try {
      const response = await alpacaHttp.get(url, {
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
      buyingPower: account.buying_power,
      equity: account.equity,
      lastEquity: account.last_equity
    };
  }

  async getPositions(context: BrokerContext): Promise<BrokerPosition[]> {
    const rows = await this.read(context, "/v2/positions", "lecture des positions", alpacaPositions);
    return (rows ?? []).map((p) => ({
      symbol: p.symbol,
      quantity: p.qty,
      averageEntryPrice: p.avg_entry_price,
      currentPrice: p.current_price ?? "0",
      marketValue: p.market_value ?? "0",
      costBasis: p.cost_basis,
      unrealizedPl: p.unrealized_pl ?? "0",
      unrealizedPlPercent: ratioToPercent(p.unrealized_plpc),
      changeTodayPercent: ratioToPercent(p.change_today)
    }));
  }

  async getPortfolioHistory(context: BrokerContext, range: HistoryRange): Promise<SeriesPoint[]> {
    const history = await this.read(
      context,
      "/v2/account/portfolio/history",
      "historique du compte",
      alpacaHistory,
      HISTORY_RANGES[range]
    );
    if (!history) return [];
    return history.timestamp.flatMap((seconds, i) => {
      const value = history.equity[i];
      return value == null
        ? []
        : [{ at: new Date(seconds * 1000).toISOString(), value: String(value) }];
    });
  }

  async getSnapshots(context: BrokerContext, symbols: string[]): Promise<MarketSnapshot[]> {
    if (symbols.length === 0) return [];
    const snapshots = await this.readData(
      context,
      "/v2/stocks/snapshots",
      "cours instantanés",
      alpacaSnapshots,
      // IEX : temps réel sur le forfait gratuit.
      { symbols: symbols.join(","), feed: "iex" }
    );

    return Object.entries(snapshots ?? {}).flatMap(([symbol, snap]) => {
      if (!snap) return [];
      const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? null;
      const previous = snap.prevDailyBar?.c ?? null;
      return [
        {
          symbol,
          price: price == null ? null : String(price),
          previousClose: previous == null ? null : String(previous),
          changePercent:
            price != null && previous
              ? (((price - previous) / previous) * 100).toFixed(2)
              : null,
          at: snap.latestTrade?.t ?? snap.dailyBar?.t ?? null
        }
      ];
    });
  }

  async getBars(context: BrokerContext, symbol: string, range: HistoryRange): Promise<SeriesPoint[]> {
    const { timeframe, days } = BAR_RANGES[range];
    const now = Date.now();
    const result = await this.readData(
      context,
      `/v2/stocks/${encodeURIComponent(symbol)}/bars`,
      "historique de cours",
      alpacaBars,
      {
        timeframe,
        start: new Date(now - days * DAY_MS).toISOString(),
        end: new Date(now - 16 * 60_000).toISOString(),
        feed: "sip",
        adjustment: "all",
        limit: "10000"
      }
    );
    const bars = result?.bars ?? [];
    const kept = range === "1J" ? lastRegularSession(bars) : bars;
    return kept.map((b) => ({ at: b.t, value: String(b.c) }));
  }

  async getNews(context: BrokerContext, symbols: string[], limit: number): Promise<NewsArticle[]> {
    const params: Record<string, string> = { limit: String(limit), sort: "desc" };
    if (symbols.length > 0) params.symbols = symbols.join(",");
    const result = await this.readData(context, "/v1beta1/news", "actualités", alpacaNews, params);
    return (result?.news ?? []).map((n) => ({
      id: String(n.id),
      headline: n.headline,
      source: n.source,
      url: n.url ?? null,
      publishedAt: n.created_at,
      symbols: n.symbols
    }));
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
