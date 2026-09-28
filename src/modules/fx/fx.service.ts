import axios from "axios";
import Decimal from "decimal.js";
import { prisma as defaultPrisma } from "@/lib/prisma.js";
import { config } from "@/config/env.js";
import { ordersConfig } from "@/config/orders.config.js";
import { BrokerError } from "@/ports/broker.errors.js";

export type FundingCurrency = "XAF" | "EUR" | "USD";

export interface FxQuote {
  currency: FundingCurrency;
  /** Unités de `currency` pour 1 USD, chaîne décimale. « 1 » pour l'USD. */
  perUsd: string;
  /** Ligne `FxRate` utilisée, pour la tracer sur l'ordre. `null` pour l'USD. */
  fxRateId: string | null;
  fetchedAt: string;
}

/**
 * ============================================================
 * TAUX DE CHANGE — pour les ordres en argent réel
 * ============================================================
 *
 * Différence de fond avec `getXafToUsdRate` (utils.ts), conservé pour le
 * simulateur : cette dernière retombe EN SILENCE sur un taux codé en dur
 * quand le fournisseur échoue. Acceptable pour une simulation, pas pour un
 * ordre réel — l'utilisateur investirait un montant qu'il n'a pas choisi.
 *
 * Ici, chaque taux utilisé est historisé en base et rattaché à l'ordre. Si
 * aucun taux assez récent n'est disponible, l'ordre est refusé
 * (`FX_UNAVAILABLE`). Jamais de taux inventé.
 */
export class FxRateService {
  private readonly prisma: typeof defaultPrisma;
  private readonly now: () => Date;
  /** Une seule requête au fournisseur à la fois, par devise. */
  private readonly inFlight = new Map<FundingCurrency, Promise<FxQuote | null>>();

  constructor(deps: { prisma?: typeof defaultPrisma; now?: () => Date } = {}) {
    this.prisma = deps.prisma ?? defaultPrisma;
    this.now = deps.now ?? (() => new Date());
  }

  async quote(currency: FundingCurrency): Promise<FxQuote> {
    if (currency === "USD") {
      return { currency, perUsd: "1", fxRateId: null, fetchedAt: this.now().toISOString() };
    }

    const settings = ordersConfig();
    const stored = await this.latestStored(currency);
    const ageSeconds = stored
      ? (this.now().getTime() - stored.fetchedAt.getTime()) / 1000
      : Infinity;

    if (stored && ageSeconds <= settings.fxRefreshSeconds) {
      return this.toQuote(currency, stored);
    }

    const fresh = await this.refresh(currency);
    if (fresh) return fresh;

    // Fournisseur en panne : un taux stocké reste acceptable jusqu'à son âge
    // maximal, pas au-delà.
    if (stored && ageSeconds <= settings.fxMaxAgeSeconds) {
      console.warn(`[fx] fournisseur indisponible, taux ${currency} de secours utilisé`);
      return this.toQuote(currency, stored);
    }

    throw new BrokerError(
      "FX_UNAVAILABLE",
      "Le taux de change n’est pas disponible pour le moment. Réessayez dans quelques minutes.",
      503
    );
  }

  private latestStored(currency: FundingCurrency) {
    return this.prisma.fxRate.findFirst({
      where: { base: "USD", quote: currency },
      orderBy: { fetchedAt: "desc" },
      select: { id: true, rate: true, fetchedAt: true }
    });
  }

  private toQuote(
    currency: FundingCurrency,
    row: { id: string; rate: { toString(): string }; fetchedAt: Date }
  ): FxQuote {
    return {
      currency,
      perUsd: row.rate.toString(),
      fxRateId: row.id,
      fetchedAt: row.fetchedAt.toISOString()
    };
  }

  private refresh(currency: FundingCurrency): Promise<FxQuote | null> {
    const pending = this.inFlight.get(currency);
    if (pending) return pending;

    const request = this.fetchAndStore(currency).finally(() =>
      this.inFlight.delete(currency)
    );
    this.inFlight.set(currency, request);
    return request;
  }

  private async fetchAndStore(currency: FundingCurrency): Promise<FxQuote | null> {
    try {
      // L'URL contient la clé d'API du fournisseur : jamais journalisée.
      const response = await axios.get(`${config.exchange_rate_url}/latest/USD`, {
        timeout: 5_000
      });

      const raw = response.data?.conversion_rates?.[currency];
      if (response.data?.result !== "success" || typeof raw !== "number") {
        console.warn(`[fx] réponse du fournisseur inexploitable pour ${currency}`);
        return null;
      }

      const rate = new Decimal(String(raw));
      if (!rate.isFinite() || rate.lte(0)) {
        console.warn(`[fx] taux ${currency} aberrant ignoré`);
        return null;
      }

      const row = await this.prisma.fxRate.create({
        data: {
          base: "USD",
          quote: currency,
          rate: rate.toString(),
          source: "exchangerate-api",
          fetchedAt: this.now()
        },
        select: { id: true, rate: true, fetchedAt: true }
      });

      return this.toQuote(currency, row);
    } catch (error) {
      console.warn("[fx] fournisseur injoignable :", (error as { code?: string })?.code ?? "erreur");
      return null;
    }
  }
}
