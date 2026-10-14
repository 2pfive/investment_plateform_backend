/**
 * Vérification du calcul du ledger (sans base) :
 *
 *   npx tsx scripts/verify-ledger.ts
 */
import assert from "node:assert/strict";
import { computeLedger, type LedgerOrder } from "../src/modules/ledger/ledger.service.js";

const t = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, n));
const order = (o: Partial<LedgerOrder>): LedgerOrder => ({
  symbol: "AAPL",
  side: "BUY",
  status: "FILLED",
  filledQuantity: "0",
  averageFilledPrice: null,
  notional: null,
  quantity: null,
  fee: "0",
  fxRate: "600",
  at: t(1),
  ...o
});

// Crédit de 100 $, achat de 2 parts à 20 $ (40 $) avec 600 FCFA de frais (1 $).
let s = computeLedger(
  [{ amountUsd: "100", at: t(0) }],
  [order({ notional: "40", filledQuantity: "2", averageFilledPrice: "20", fee: "600" })]
);
assert.equal(s.cashUsd.toFixed(2), "59.00");
assert.equal(s.reservedUsd.toFixed(2), "0.00");
assert.equal(s.holdings.get("AAPL")!.quantity.toFixed(), "2");
assert.equal(s.holdings.get("AAPL")!.cost.toFixed(2), "40.00");

// Achat en cours, non exécuté : le montant ET les frais sont réservés, le solde intact.
s = computeLedger(
  [{ amountUsd: "100", at: t(0) }],
  [order({ status: "ACCEPTED", notional: "30", fee: "600" })]
);
assert.equal(s.cashUsd.toFixed(2), "100.00");
assert.equal(s.reservedUsd.toFixed(2), "31.00");

// Vente de la moitié à 30 $ : crédit de 30 $, prix de revient réduit au prorata.
s = computeLedger(
  [{ amountUsd: "100", at: t(0) }],
  [
    order({ notional: "40", filledQuantity: "2", averageFilledPrice: "20", at: t(1) }),
    order({ side: "SELL", quantity: "1", filledQuantity: "1", averageFilledPrice: "30", at: t(2) })
  ]
);
assert.equal(s.cashUsd.toFixed(2), "90.00");
assert.equal(s.holdings.get("AAPL")!.quantity.toFixed(), "1");
assert.equal(s.holdings.get("AAPL")!.cost.toFixed(2), "20.00");

// Vente en cours : sa quantité restante n'est plus disponible.
s = computeLedger(
  [{ amountUsd: "100", at: t(0) }],
  [
    order({ notional: "40", filledQuantity: "2", averageFilledPrice: "20", at: t(1) }),
    order({ side: "SELL", status: "ACCEPTED", quantity: "1.5", at: t(2) })
  ]
);
assert.equal(s.pendingSellQuantity.get("AAPL")!.toFixed(), "1.5");

// Achat annulé sans exécution : ni débit, ni frais, ni réservation.
s = computeLedger(
  [{ amountUsd: "100", at: t(0) }],
  [order({ status: "CANCELLED", notional: "40", fee: "600" })]
);
assert.equal(s.cashUsd.toFixed(2), "100.00");
assert.equal(s.reservedUsd.toFixed(2), "0.00");

console.log("ledger : OK");
