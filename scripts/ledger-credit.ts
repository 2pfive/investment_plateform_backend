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
import { prisma } from "../src/lib/prisma.js";
import { ledgerFor, postCashMovement } from "../src/modules/ledger/ledger.service.js";

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
    const currency = (rawCurrency ?? "").toUpperCase() as "XAF" | "USD" | "EUR";
    const m = await postCashMovement({
      userId,
      environment,
      amount: rawAmount,
      currency,
      note: note ?? "",
      createdBy: os.userInfo().username
    }).catch((e: Error) => fail(e.message));
    console.log(`Écriture passée : ${m.amount.toFixed()} ${currency} = ${m.amountUsd.toFixed(2)} $ (${environment}).`);
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
