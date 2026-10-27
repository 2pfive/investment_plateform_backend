import Decimal from "decimal.js";
import { prisma as defaultPrisma } from "@/lib/prisma.js";
import { AppError } from "@/utils/errorHandler.js";
import { TERMINAL_STATUSES } from "@/modules/orders/order.dto.js";
import type { BrokerEnvironment, OrderSideName, OrderStatusName } from "@/ports/broker.port.js";

/**
 * ============================================================
 * LEDGER INTERNE — compte de courtage partagé
 * ============================================================
 *
 * Pendant le pilote, l'argent réel de tous les utilisateurs passe par UN
 * compte Alpaca (LIVE) : ce qu'Alpaca rapporte est la somme de tout le monde,
 * la part de chacun se lit ici. La simulation (PAPER) est tenue de la même
 * façon, sur un solde virtuel, sans rien envoyer à Alpaca.
 *
 * Deux sources par utilisateur ET par mode, aucune copie :
 *
 * - `CashMovement` : espèces créditées ou débitées (équipe, dotation virtuelle) ;
 * - `Order` : quantités et prix EXÉCUTÉS (rapportés par Alpaca, ou simulés).
 *
 * Règles :
 *
 * - un achat débite le montant exécuté, plus les frais dès qu'il est exécuté
 *   même partiellement ; tant qu'il est en cours, le reste de son montant est
 *   réservé et n'est plus disponible ;
 * - une vente crédite le montant exécuté, moins les frais ; tant qu'elle est
 *   en cours, sa quantité restante n'est plus disponible à la vente ;
 * - prix de revient moyen pondéré : une vente le réduit au prorata.
 */

type Dec = InstanceType<typeof Decimal>;
type DecValue = string | number | Dec;

const ZERO = new Decimal(0);

export interface LedgerMovement {
  amountUsd: DecValue;
  at: Date;
}

export interface LedgerOrder {
  symbol: string;
  side: OrderSideName;
  status: OrderStatusName;
  filledQuantity: DecValue;
  averageFilledPrice: DecValue | null;
  /** Dollars transmis (achat) ou estimés (vente). */
  notional: DecValue | null;
  /** Quantité transmise : ventes seulement. */
  quantity: DecValue | null;
  /** Dans la devise de saisie ; `fxRate` = unités de cette devise pour 1 USD. */
  fee: DecValue;
  fxRate: DecValue | null;
  at: Date;
}

export interface Holding {
  quantity: Dec;
  /** Prix de revient total, en dollars. */
  cost: Dec;
}

export interface LedgerState {
  cashUsd: Dec;
  /** Montant des achats en cours, plus disponible. */
  reservedUsd: Dec;
  holdings: Map<string, Holding>;
  /** Quantité des ventes en cours, par symbole. */
  pendingSellQuantity: Map<string, Dec>;
}

export function feeUsd(order: Pick<LedgerOrder, "fee" | "fxRate">): Dec {
  const rate = new Decimal(order.fxRate ?? 0);
  return rate.gt(0) ? new Decimal(order.fee).div(rate) : ZERO;
}

/** État du ledger d'un utilisateur. Pur : testé sans base. */
export function computeLedger(movements: LedgerMovement[], orders: LedgerOrder[]): LedgerState {
  let cashUsd = movements.reduce((sum, m) => sum.plus(m.amountUsd), ZERO);
  let reservedUsd = ZERO;
  const holdings = new Map<string, Holding>();
  const pendingSellQuantity = new Map<string, Dec>();

  for (const order of [...orders].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const filled = new Decimal(order.filledQuantity);
    const executed = filled.times(order.averageFilledPrice ?? 0);
    const fee = filled.gt(0) ? feeUsd(order) : ZERO;
    const active = !TERMINAL_STATUSES.has(order.status);
    const holding = holdings.get(order.symbol) ?? { quantity: ZERO, cost: ZERO };

    if (order.side === "BUY") {
      cashUsd = cashUsd.minus(executed).minus(fee);
      if (active) {
        const rest = Decimal.max(new Decimal(order.notional ?? 0).minus(executed), ZERO);
        reservedUsd = reservedUsd.plus(rest).plus(filled.gt(0) ? ZERO : feeUsd(order));
      }
      holdings.set(order.symbol, { quantity: holding.quantity.plus(filled), cost: holding.cost.plus(executed) });
    } else {
      cashUsd = cashUsd.plus(executed).minus(fee);
      if (active) {
        const rest = Decimal.max(new Decimal(order.quantity ?? 0).minus(filled), ZERO);
        pendingSellQuantity.set(order.symbol, (pendingSellQuantity.get(order.symbol) ?? ZERO).plus(rest));
      }
      const share = holding.quantity.gt(0) ? Decimal.min(filled.div(holding.quantity), 1) : new Decimal(1);
      holdings.set(order.symbol, {
        quantity: holding.quantity.minus(filled),
        cost: holding.cost.minus(holding.cost.times(share))
      });
    }
  }

  return { cashUsd, reservedUsd, holdings, pendingSellQuantity };
}

/** Client Prisma ou transaction en cours. */
type Db = Pick<typeof defaultPrisma, "cashMovement" | "order">;

/** Mouvements et ordres d'un utilisateur dans un mode, au format de `computeLedger`. */
export async function loadLedger(userId: string, environment: BrokerEnvironment, db: Db = defaultPrisma) {
  const [movements, orders] = await Promise.all([
    db.cashMovement.findMany({ where: { userId, environment }, select: { amountUsd: true, createdAt: true } }),
    db.order.findMany({
      where: { userId, brokerConnection: { environment } },
      select: {
        side: true,
        status: true,
        filledQuantity: true,
        averageFilledPrice: true,
        notional: true,
        quantity: true,
        fee: true,
        fxRate: true,
        filledAt: true,
        updatedAt: true,
        asset: { select: { symbol: true } }
      }
    })
  ]);

  return {
    movements: movements.map((m) => ({ amountUsd: m.amountUsd.toString(), at: m.createdAt })),
    orders: orders.map(
      (o): LedgerOrder => ({
        symbol: o.asset.symbol,
        side: o.side,
        status: o.status,
        filledQuantity: o.filledQuantity.toString(),
        averageFilledPrice: o.averageFilledPrice?.toString() ?? null,
        notional: o.notional?.toString() ?? null,
        quantity: o.quantity?.toString() ?? null,
        fee: o.fee.toString(),
        fxRate: o.fxRate?.toString() ?? null,
        at: o.filledAt ?? o.updatedAt
      })
    )
  };
}

export async function ledgerFor(
  userId: string,
  environment: BrokerEnvironment,
  db: Db = defaultPrisma
): Promise<LedgerState> {
  const { movements, orders } = await loadLedger(userId, environment, db);
  return computeLedger(movements, orders);
}

/**
 * Sérialise les écritures d'un même utilisateur (ordres, crédits) : sans
 * verrou, deux achats simultanés passeraient chacun la vérification du solde.
 * Verrou de transaction PostgreSQL : tient même avec plusieurs instances.
 */
export async function lockUser(tx: { $executeRaw: typeof defaultPrisma.$executeRaw }, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ledger:" + userId}))`;
}

/**
 * Dotation virtuelle de départ, une seule fois par utilisateur : la référence
 * unique rend l'appel idempotent, même sous requêtes simultanées.
 */
export async function ensureSimulationFunding(userId: string, amountUsd: string, db = defaultPrisma) {
  await db.cashMovement.createMany({
    data: [
      {
        userId,
        environment: "PAPER",
        amountUsd,
        amount: amountUsd,
        currency: "USD",
        fxRate: "1",
        note: "Solde virtuel de départ (simulation)",
        createdBy: "system",
        reference: `simulation-start:${userId}`
      }
    ],
    skipDuplicates: true
  });
}

/**
 * Crédit (montant positif) ou débit (négatif) manuel d'un utilisateur, converti
 * en dollars au taux du jour. Un débit ne peut dépasser le disponible.
 * Utilisé par le back-office et par `scripts/ledger-credit.ts`.
 */
export async function postCashMovement(input: {
  userId: string;
  environment: BrokerEnvironment;
  amount: string;
  currency: "XAF" | "USD" | "EUR";
  note: string;
  createdBy: string;
}) {
  let amount: Dec;
  try {
    amount = new Decimal(input.amount);
  } catch {
    throw new AppError("Montant invalide.", 400);
  }
  if (amount.isZero() || !amount.isFinite()) throw new AppError("Montant invalide.", 400);
  if (!["XAF", "USD", "EUR"].includes(input.currency)) throw new AppError("Devise attendue : XAF, USD ou EUR.", 400);
  const note = input.note?.trim();
  if (!note) throw new AppError("Une note est obligatoire (référence du paiement, motif).", 400);

  // Import tardif : le service FX tire la config réseau, inutile aux tests purs.
  const { FxRateService } = await import("@/modules/fx/fx.service.js");
  const quote = await new FxRateService().quote(input.currency);
  const amountUsd = amount.div(quote.perUsd).toDecimalPlaces(2, Decimal.ROUND_DOWN);

  return defaultPrisma.$transaction(async (tx) => {
    await lockUser(tx, input.userId);
    if (amountUsd.isNegative()) {
      const state = await ledgerFor(input.userId, input.environment, tx);
      const available = state.cashUsd.minus(state.reservedUsd);
      if (amountUsd.abs().gt(available)) throw new AppError(`Débit refusé : ${available.toFixed(2)} $ disponibles seulement.`, 400);
    }
    return tx.cashMovement.create({
      data: {
        userId: input.userId,
        environment: input.environment,
        amountUsd: amountUsd.toFixed(2),
        amount: amount.toFixed(),
        currency: input.currency,
        fxRate: quote.perUsd,
        note,
        createdBy: input.createdBy
      }
    });
  });
}
