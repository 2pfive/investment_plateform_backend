import crypto from "crypto";
import Decimal from "decimal.js";
import type {
  BrokerAccount,
  BrokerContext,
  BrokerEnvironment,
  BrokerOrder,
  BrokerPosition,
  BrokerProvider,
  HistoryRange,
  NotionalOrderRequest,
  SeriesPoint
} from "@/ports/broker.port.js";
import { BrokerError } from "@/ports/broker.errors.js";
import { computeLedger, ledgerFor, loadLedger } from "./ledger.service.js";

const ZERO = new Decimal(0);

/** Dernière clôture à `at` ou avant ; `points` est trié par date. */
function closeAt(points: SeriesPoint[], at: string): string | null {
  let found: string | null = null;
  for (const point of points) {
    if (point.at > at) break;
    found = point.value;
  }
  return found;
}

/**
 * ============================================================
 * COURTIER VU À TRAVERS LE LEDGER
 * ============================================================
 *
 * Enveloppe le fournisseur Alpaca pour un utilisateur du mode pilote :
 *
 * - solde, positions et historique viennent du ledger de CET utilisateur,
 *   jamais du compte Alpaca, partagé entre tous ;
 * - en simulation (`simulate`), les ordres sont exécutés ici, au dernier
 *   cours, sans aucun appel à l'API de trading d'Alpaca ;
 * - tout le reste (cours, actifs, actualités) passe tel quel.
 *
 * Le contexte transmis ne sert qu'aux données de marché.
 */
export class LedgerProvider implements BrokerProvider {
  constructor(
    private readonly inner: BrokerProvider,
    private readonly userId: string,
    private readonly environment: BrokerEnvironment,
    private readonly simulate: boolean
  ) {}

  /* --- Données de marché : inchangées --- */

  getAsset: BrokerProvider["getAsset"] = (c, s) => this.inner.getAsset(c, s);
  getClock: BrokerProvider["getClock"] = (c) => this.inner.getClock(c);
  getSnapshots: BrokerProvider["getSnapshots"] = (c, s) => this.inner.getSnapshots(c, s);
  getBars: BrokerProvider["getBars"] = (c, s, r) => this.inner.getBars(c, s, r);
  getNews: BrokerProvider["getNews"] = (c, s, l) => this.inner.getNews(c, s, l);
  listAssets: BrokerProvider["listAssets"] = (c) => this.inner.listAssets(c);
  getDollarVolumes: BrokerProvider["getDollarVolumes"] = (c, s) => this.inner.getDollarVolumes(c, s);

  /* --- Compte de l'utilisateur, d'après le ledger --- */

  /** Positions détenues, valorisées au dernier cours. */
  private async valued(context: BrokerContext) {
    const state = await ledgerFor(this.userId, this.environment);
    const held = [...state.holdings].filter(([, h]) => h.quantity.gt(0));
    const snapshots = held.length
      ? await this.inner.getSnapshots(context, held.map(([symbol]) => symbol))
      : [];
    const bySymbol = new Map(snapshots.map((s) => [s.symbol, s]));

    const rows = held.map(([symbol, h]) => {
      const snapshot = bySymbol.get(symbol);
      // Sans cours, la position reste valorisée à son prix de revient plutôt
      // qu'à zéro : un trou dans les données n'est pas une perte.
      const price = new Decimal(snapshot?.price ?? h.cost.div(h.quantity));
      const previous = new Decimal(snapshot?.previousClose ?? price);
      return { symbol, holding: h, price, previous, changePercent: snapshot?.changePercent ?? "0" };
    });

    return { state, rows };
  }

  async getAccount(context: BrokerContext): Promise<BrokerAccount> {
    const { state, rows } = await this.valued(context);
    const value = rows.reduce((sum, r) => sum.plus(r.holding.quantity.times(r.price)), ZERO);
    const lastValue = rows.reduce((sum, r) => sum.plus(r.holding.quantity.times(r.previous)), ZERO);

    return {
      externalId: `amara-${this.environment.toLowerCase()}-${this.userId}`,
      accountNumber: this.userId.replace(/-/g, "").toUpperCase(),
      status: "ACTIVE",
      canTrade: true,
      currency: "USD",
      cash: state.cashUsd.toFixed(2),
      buyingPower: Decimal.max(state.cashUsd.minus(state.reservedUsd), ZERO).toFixed(2),
      equity: state.cashUsd.plus(value).toFixed(2),
      lastEquity: state.cashUsd.plus(lastValue).toFixed(2)
    };
  }

  async getPositions(context: BrokerContext): Promise<BrokerPosition[]> {
    const { rows } = await this.valued(context);
    return rows.map(({ symbol, holding, price, changePercent }) => {
      const marketValue = holding.quantity.times(price);
      const pl = marketValue.minus(holding.cost);
      return {
        symbol,
        quantity: holding.quantity.toFixed(),
        averageEntryPrice: holding.cost.div(holding.quantity).toFixed(4),
        currentPrice: price.toFixed(),
        marketValue: marketValue.toFixed(2),
        costBasis: holding.cost.toFixed(2),
        unrealizedPl: pl.toFixed(2),
        unrealizedPlPercent: holding.cost.gt(0) ? pl.div(holding.cost).times(100).toFixed(2) : "0",
        changeTodayPercent: changePercent
      };
    });
  }

  /**
   * Valeur au fil de la période : espèces + titres détenus à chaque date,
   * valorisés à la clôture. SPY ne sert que d'horloge des séances.
   *
   * ponytail: rejoue le ledger à chaque point (points × ordres) ; à
   * remplacer par des instantanés quotidiens si un compte dépasse quelques
   * centaines d'ordres.
   */
  async getPortfolioHistory(context: BrokerContext, range: HistoryRange): Promise<SeriesPoint[]> {
    const { movements, orders } = await loadLedger(this.userId, this.environment);
    if (movements.length === 0) return [];

    const symbols = [...new Set(orders.map((o) => o.symbol))];
    const series = await Promise.all(
      ["SPY", ...symbols].map((s) => this.inner.getBars(context, s, range).catch(() => []))
    );
    const bars = new Map(symbols.map((s, i) => [s, series[i + 1]!]));
    const times = [...new Set(series.flat().map((p) => p.at))].sort();
    const start = Math.min(...movements.map((m) => m.at.getTime()));

    return times
      .filter((at) => new Date(at).getTime() >= start)
      .map((at) => {
        const t = new Date(at);
        const state = computeLedger(
          movements.filter((m) => m.at <= t),
          orders.filter((o) => o.at <= t)
        );
        let value = state.cashUsd;
        for (const [symbol, h] of state.holdings) {
          if (!h.quantity.gt(0)) continue;
          const close = closeAt(bars.get(symbol) ?? [], at);
          value = value.plus(h.quantity.times(close ?? h.cost.div(h.quantity)));
        }
        return { at, value: value.toFixed(2) };
      });
  }

  /* --- Ordres : transmis, ou exécutés ici en simulation --- */

  async placeNotionalOrder(context: BrokerContext, request: NotionalOrderRequest): Promise<BrokerOrder> {
    if (!this.simulate) return this.inner.placeNotionalOrder(context, request);

    const [snapshot] = await this.inner.getSnapshots(context, [request.symbol]);
    if (!snapshot?.price) {
      throw new BrokerError("ORDER_REJECTED", `Cours de ${request.symbol} indisponible : réessayez dans un instant.`, 422);
    }

    // ponytail: exécution immédiate au dernier cours, même marché fermé ; une
    // file jusqu'à l'ouverture si la simulation doit coller au réel.
    const quantity = request.quantity
      ? new Decimal(request.quantity)
      : new Decimal(request.notional).div(snapshot.price).toDecimalPlaces(9, Decimal.ROUND_DOWN);
    const now = new Date().toISOString();

    return {
      externalId: `sim-${crypto.randomUUID()}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      status: "FILLED",
      rawStatus: "simulated",
      notional: request.quantity ? null : request.notional,
      quantity: request.quantity ?? null,
      filledQuantity: quantity.toFixed(),
      averageFilledPrice: snapshot.price,
      submittedAt: now,
      filledAt: now,
      cancelledAt: null,
      expiredAt: null,
      failedAt: null,
      updatedAt: now
    };
  }

  // Un ordre simulé est exécuté dès son passage : il n'y a rien à relire.
  getOrder: BrokerProvider["getOrder"] = (c, id) =>
    this.simulate ? Promise.resolve(null) : this.inner.getOrder(c, id);
  findOrderByClientOrderId: BrokerProvider["findOrderByClientOrderId"] = (c, id) =>
    this.simulate ? Promise.resolve(null) : this.inner.findOrderByClientOrderId(c, id);
}
