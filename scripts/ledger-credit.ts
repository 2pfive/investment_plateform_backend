/**
 * ============================================================
 * LEDGER — crédit ou débit manuel d'un utilisateur (mode pilote)
 * ============================================================
 *
 * Seule porte d'entrée de l'argent réel pendant le pilote : l'équipe crédite
 * un utilisateur après avoir reçu son paiement (Mobile Money…), hors
 * application. Aucune route HTTP : il faut un accès au serveur.
 *
 *   Solde :  npm run ledger -- <email>
 *   Crédit : npm run ledger -- <email> 5000 XAF "Orange Money réf 123"
 *   Débit :  npm run ledger -- <email> -5000 XAF "Retrait réf 456"
 *
 * Argent réel (LIVE) par défaut ; `--paper` pour le solde virtuel de simulation.
 */
import os from "node:os";
import Decimal from "decimal.js";
import { prisma } from "../src/lib/prisma.js";
import { FxRateService, type FundingCurrency } from "../src/modules/fx/fx.service.js";
import { ledgerFor, lockUser } from "../src/modules/ledger/ledger.service.js";

const args = process.argv.slice(2).filter((a) => a !== "--paper");
const environment = process.argv.includes("--paper") ? "PAPER" : "LIVE";
const [email, rawAmount, rawCurrency, note] = args;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  if (!email) fail("Usage : npm run ledger -- <email> [<montant> <XAF|USD|EUR> \"<note>\"] [--paper]");

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { user_id: true } });
  if (!user?.user_id) fail(`Aucun utilisateur ${email}.`);
  const userId = user.user_id;

  if (rawAmount !== undefined) {
    const currency = (rawCurrency ?? "").toUpperCase() as FundingCurrency;
    if (!["XAF", "USD", "EUR"].includes(currency)) fail("Devise attendue : XAF, USD ou EUR.");
    if (!note?.trim()) fail("Une note est obligatoire (référence du paiement, motif).");
    let amount: Decimal;
    try {
      amount = new Decimal(rawAmount);
    } catch {
      fail("Montant invalide.");
    }
    if (amount.isZero() || !amount.isFinite()) fail("Montant invalide.");

    const quote = await new FxRateService().quote(currency);
    const amountUsd = amount.div(quote.perUsd).toDecimalPlaces(2, Decimal.ROUND_DOWN);

    await prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      if (amountUsd.isNegative()) {
        const state = await ledgerFor(userId, environment, tx);
        const available = state.cashUsd.minus(state.reservedUsd);
        if (amountUsd.abs().gt(available)) fail(`Débit refusé : ${available.toFixed(2)} $ disponibles seulement.`);
      }
      await tx.cashMovement.create({
        data: {
          userId,
          environment,
          amountUsd: amountUsd.toFixed(2),
          amount: amount.toFixed(),
          currency,
          fxRate: quote.perUsd,
          note: note!.trim(),
          createdBy: os.userInfo().username
        }
      });
    });
    console.log(`Écriture passée : ${amount.toFixed()} ${currency} = ${amountUsd.toFixed(2)} $ (${environment}).`);
  }

  const state = await ledgerFor(userId, environment);
  console.log(`${email} — ${environment === "LIVE" ? "argent réel" : "simulation"}`);
  console.log(`  Espèces      : ${state.cashUsd.toFixed(2)} $`);
  console.log(`  Disponible   : ${state.cashUsd.minus(state.reservedUsd).toFixed(2)} $`);
  for (const [symbol, h] of state.holdings) {
    if (h.quantity.gt(0)) console.log(`  ${symbol.padEnd(12)} : ${h.quantity.toFixed()} parts, revient ${h.cost.toFixed(2)} $`);
  }
}

main()
  .catch((error) => fail(`Échec : ${(error as Error).message}`))
  .finally(() => prisma.$disconnect());
