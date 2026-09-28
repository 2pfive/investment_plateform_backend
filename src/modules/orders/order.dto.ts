import type { OrderStatusName } from "@/ports/broker.port.js";

/**
 * ============================================================
 * ORDRE — représentation et transitions
 * ============================================================
 */

/** Statuts après lesquels plus rien ne doit changer. */
export const TERMINAL_STATUSES: ReadonlySet<OrderStatusName> = new Set([
  "FILLED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "FAILED"
]);

export const NON_TERMINAL_STATUSES: OrderStatusName[] = [
  "CREATED",
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED"
];

/**
 * Rang d'avancement. Une lecture tardive du courtier (réponse en cache,
 * requêtes croisées) ne doit jamais faire reculer un ordre : un ordre vu
 * « partiellement exécuté » ne redevient pas « accepté ».
 */
const RANK: Record<OrderStatusName, number> = {
  CREATED: 0,
  SUBMITTED: 1,
  ACCEPTED: 2,
  PARTIALLY_FILLED: 3,
  FILLED: 4,
  CANCELLED: 4,
  REJECTED: 4,
  EXPIRED: 4,
  FAILED: 4
};

export type TransitionDecision =
  | { apply: true }
  | { apply: false; anomaly: boolean };

/**
 * Faut-il appliquer le statut rapporté par le courtier ?
 *
 * - En avant : oui.
 * - Identique : non, sans anomalie.
 * - En arrière, ou d'un état terminal à un autre : non, et c'est une
 *   anomalie à réconcilier.
 * - Exception : `FAILED` est une conclusion d'AMARA (« le courtier n'a
 *   jamais reçu l'ordre »). Si le courtier le rapporte finalement, c'est lui
 *   qui a raison.
 */
export function decideTransition(
  current: OrderStatusName,
  next: OrderStatusName
): TransitionDecision {
  if (current === next) return { apply: false, anomaly: false };
  if (current === "FAILED") return { apply: true };
  if (TERMINAL_STATUSES.has(current)) return { apply: false, anomaly: true };
  if (RANK[next] < RANK[current]) return { apply: false, anomaly: true };
  return { apply: true };
}

/** Décimal Prisma → chaîne en notation normale (jamais « 1e-9 »). */
export function decimalToString(value: { toFixed(): string } | null | undefined): string | null {
  return value == null ? null : value.toFixed();
}

export interface OrderDto {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  status: OrderStatusName;
  environment: "PAPER" | "LIVE" | null;

  /** Ce que l'utilisateur a saisi, dans sa devise. */
  requestedAmount: string;
  requestedCurrency: string;
  fee: string;
  /** Ce qui est parti chez le courtier, en dollars. */
  notionalUsd: string | null;
  /** Unités de la devise saisie pour 1 USD, au moment de l'ordre. */
  fxRate: string | null;

  /** Exécution réelle — fait foi, contrairement à toute estimation. */
  filledQuantity: string;
  averageFilledPrice: string | null;

  submittedAt: string | null;
  filledAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;

  failureCode: string | null;
  failureMessage: string | null;
  /**
   * La transmission a eu une issue inconnue (coupure réseau) : l'ordre a pu
   * partir. Le mobile doit dire « confirmation en attente », pas « échec ».
   */
  pendingConfirmation: boolean;

  createdAt: string;
  updatedAt: string;
}

export const ORDER_DTO_SELECT = {
  id: true,
  clientOrderId: true,
  side: true,
  status: true,
  requestedAmount: true,
  requestedCurrency: true,
  fee: true,
  notional: true,
  fxRate: true,
  filledQuantity: true,
  averageFilledPrice: true,
  submittedAt: true,
  filledAt: true,
  cancelledAt: true,
  expiresAt: true,
  failureCode: true,
  failureMessage: true,
  createdAt: true,
  updatedAt: true,
  asset: { select: { symbol: true } },
  brokerConnection: { select: { environment: true } }
} as const;

type SelectedOrder = {
  id: string;
  clientOrderId: string;
  side: "BUY" | "SELL";
  status: OrderStatusName;
  requestedAmount: { toFixed(): string };
  requestedCurrency: string;
  fee: { toFixed(): string };
  notional: { toFixed(): string } | null;
  fxRate: { toFixed(): string } | null;
  filledQuantity: { toFixed(): string };
  averageFilledPrice: { toFixed(): string } | null;
  submittedAt: Date | null;
  filledAt: Date | null;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  asset: { symbol: string };
  brokerConnection: { environment: "PAPER" | "LIVE" } | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const PENDING_CONFIRMATION = "PENDING_CONFIRMATION";

export function toOrderDto(order: SelectedOrder): OrderDto {
  return {
    id: order.id,
    clientOrderId: order.clientOrderId,
    symbol: order.asset.symbol,
    side: order.side,
    status: order.status,
    environment: order.brokerConnection?.environment ?? null,
    requestedAmount: order.requestedAmount.toFixed(),
    requestedCurrency: order.requestedCurrency,
    fee: order.fee.toFixed(),
    notionalUsd: decimalToString(order.notional),
    fxRate: decimalToString(order.fxRate),
    filledQuantity: order.filledQuantity.toFixed(),
    averageFilledPrice: decimalToString(order.averageFilledPrice),
    submittedAt: iso(order.submittedAt),
    filledAt: iso(order.filledAt),
    cancelledAt: iso(order.cancelledAt),
    expiredAt: iso(order.expiresAt),
    failureCode: order.failureCode,
    failureMessage: order.failureMessage,
    pendingConfirmation:
      order.status === "SUBMITTED" && order.failureCode === PENDING_CONFIRMATION,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString()
  };
}
