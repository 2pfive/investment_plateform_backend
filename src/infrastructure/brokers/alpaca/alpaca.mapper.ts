import { z } from "zod";
import type {
  BrokerAsset,
  BrokerOrder,
  MarketClock,
  OrderStatusName
} from "@/ports/broker.port.js";

/**
 * ============================================================
 * TRADUCTION ALPACA → AMARA
 * ============================================================
 *
 * Seul endroit qui connaît les formes brutes d'Alpaca. Chaque réponse est
 * validée avant d'être traduite : un champ manquant produit une erreur
 * franche ici, plutôt qu'un `undefined` qui voyagerait jusqu'à la base.
 */

/**
 * Alpaca expose dix-sept statuts ; AMARA en garde huit.
 *
 * Tout statut absent de cette table est INCONNU : `toOrderStatus` renvoie
 * `null`, et l'appelant conserve l'état précédent en ouvrant une
 * réconciliation. Deviner un statut sur un ordre en argent réel est pire que
 * ne pas savoir.
 */
const STATUS: Record<string, OrderStatusName> = {
  pending_new: "SUBMITTED",
  accepted_for_bidding: "SUBMITTED",

  new: "ACCEPTED",
  accepted: "ACCEPTED",
  held: "ACCEPTED",
  calculated: "ACCEPTED",
  pending_replace: "ACCEPTED",
  replaced: "ACCEPTED",
  pending_cancel: "ACCEPTED",
  stopped: "ACCEPTED",
  suspended: "ACCEPTED",

  partially_filled: "PARTIALLY_FILLED",
  filled: "FILLED",
  canceled: "CANCELLED",
  rejected: "REJECTED",
  expired: "EXPIRED",
  // Fin de séance sans exécution complète : pour un ordre `day`, c'est la fin.
  done_for_day: "EXPIRED"
};

export function toOrderStatus(raw: string): OrderStatusName | null {
  return STATUS[raw] ?? null;
}

const nullableString = z.string().nullable().optional().transform((v) => v ?? null);

export const alpacaOrder = z.object({
  id: z.string().min(1),
  client_order_id: z.string(),
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  status: z.string(),
  notional: nullableString,
  qty: nullableString,
  filled_qty: z.string().nullable().optional().transform((v) => v ?? "0"),
  filled_avg_price: nullableString,
  submitted_at: nullableString,
  filled_at: nullableString,
  canceled_at: nullableString,
  expired_at: nullableString,
  failed_at: nullableString,
  updated_at: nullableString
});

export function toBrokerOrder(raw: z.infer<typeof alpacaOrder>): BrokerOrder {
  return {
    externalId: raw.id,
    clientOrderId: raw.client_order_id,
    symbol: raw.symbol,
    side: raw.side === "buy" ? "BUY" : "SELL",
    status: toOrderStatus(raw.status),
    rawStatus: raw.status,
    notional: raw.notional,
    quantity: raw.qty,
    filledQuantity: raw.filled_qty,
    averageFilledPrice: raw.filled_avg_price,
    submittedAt: raw.submitted_at,
    filledAt: raw.filled_at,
    cancelledAt: raw.canceled_at,
    expiredAt: raw.expired_at,
    failedAt: raw.failed_at,
    updatedAt: raw.updated_at
  };
}

export const alpacaAsset = z.object({
  id: z.string().min(1),
  symbol: z.string(),
  name: z.string().default(""),
  exchange: z.string().nullable().optional(),
  status: z.string(),
  tradable: z.boolean().default(false),
  fractionable: z.boolean().default(false),
  shortable: z.boolean().default(false)
});

export function toBrokerAsset(raw: z.infer<typeof alpacaAsset>): BrokerAsset {
  return {
    externalId: raw.id,
    symbol: raw.symbol,
    name: raw.name || raw.symbol,
    exchange: raw.exchange ?? null,
    tradable: raw.tradable,
    fractionable: raw.fractionable,
    shortable: raw.shortable,
    active: raw.status === "active"
  };
}

export const alpacaClock = z.object({
  timestamp: z.string(),
  is_open: z.boolean(),
  next_open: z.string(),
  next_close: z.string()
});

export function toMarketClock(raw: z.infer<typeof alpacaClock>): MarketClock {
  return {
    isOpen: raw.is_open,
    nextOpen: raw.next_open,
    nextClose: raw.next_close,
    timestamp: raw.timestamp
  };
}
