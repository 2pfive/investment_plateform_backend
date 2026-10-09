/**
 * Vérifie l'extraction des comptes SEC : `npx tsx scripts/verify-fundamentals.ts`.
 *
 * 1. Règles de calcul, sans réseau (FCF, trésorerie élargie).
 * 2. Lecture réelle de la SEC sur des cas typés : Apple (placements à court
 *    terme), une société au FCF négatif, une sans placements, une sans
 *    comptes US-GAAP. Pas de base de données : `summarize` seul.
 */
import assert from "node:assert/strict";
import axios from "axios";
import { cashPosition, freeCashFlow, summarize } from "../src/modules/live/sec.fundamentals.js";

const fact = (end: string, val: number, form = "10-Q", filed = end) => ({ end, val, form, filed, accn: filed });

// --- 1. Règles ---
assert.equal(freeCashFlow(100, 30), 70);
assert.equal(freeCashFlow(100, -30), 70, "CapEx publié en négatif");
assert.equal(freeCashFlow(100, null), null, "CapEx absent : pas de FCF inventé");
assert.equal(freeCashFlow(null, 30), null);
assert.equal(freeCashFlow(10, 30), -20, "FCF négatif conservé");

const units = (...f: ReturnType<typeof fact>[]) => ({ units: { USD: f } });
assert.deepEqual(
  cashPosition({
    CashAndCashEquivalentsAtCarryingValue: units(fact("2025-06-30", 30)),
    MarketableSecuritiesCurrent: units(fact("2025-06-30", 35))
  }),
  { end: "2025-06-30", cash: 65, shortTermInvestments: 35 }
);
assert.deepEqual(
  cashPosition({
    CashAndCashEquivalentsAtCarryingValue: units(fact("2025-06-30", 30)),
    ShortTermInvestments: units(fact("2025-03-31", 35))
  }),
  { end: "2025-06-30", cash: 30, shortTermInvestments: null },
  "placements d'une autre date : non additionnés"
);
assert.deepEqual(
  cashPosition({
    CashAndCashEquivalentsAtCarryingValue: units(fact("2025-06-30", 30)),
    ShortTermInvestments: units(fact("2025-06-30", 5)),
    MarketableSecuritiesCurrent: units(fact("2025-06-30", 5, "10-Q", "2025-08-01"))
  })?.cash,
  35,
  "deux étiquettes pour la même ligne : comptée une fois"
);
assert.equal(cashPosition({}), null);
console.log("Règles : OK");

// --- 2. SEC réelle ---
const http = axios.create({
  timeout: 20_000,
  headers: { "User-Agent": process.env.SEC_USER_AGENT || "AmaraBackend/1.0 verify script" }
});
const { data: tickers } = await http.get("https://www.sec.gov/files/company_tickers.json");
const cikOf = (t: string) =>
  (Object.values(tickers) as { ticker: string; cik_str: number }[]).find((r) => r.ticker === t)?.cik_str;

const b = (n: number | null | undefined) => (n == null ? "—" : `${(n / 1e9).toFixed(2)} Md`);

for (const [symbol, expect] of [
  ["AAPL", "placements à court terme"],
  ["RIVN", "FCF négatif"],
  ["NFLX", "sans placements à court terme ?"],
  ["TSM", "pas de comptes US-GAAP"]
] as const) {
  const cik = cikOf(symbol);
  const { data } = cik
    ? await http.get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`)
    : { data: null };
  const f = data?.facts ? summarize(cik!, data.facts) : null;
  console.log(`\n${symbol} (${expect})`);
  if (!f) {
    console.log("  aucun compte");
    continue;
  }
  const l = f.latest!;
  console.log(`  exercice clos le ${l.end}`);
  console.log(`  exploitation ${b(l.operatingCashFlow)} − investissements ${b(l.capitalExpenditure)} = FCF ${b(l.freeCashFlow)}`);
  console.log(`  bilan au ${f.balance.end} : argent ${b(f.balance.cash)} (dont placements ${b(f.balance.shortTermInvestments)}), dette ${b(f.balance.debt)}`);
  console.log(`  FCF par année : ${f.annual.map((a) => `${a.year} ${b(a.freeCashFlow)}`).join(" | ")}`);

  for (const a of f.annual) {
    if (a.freeCashFlow != null) assert.equal(a.freeCashFlow, a.operatingCashFlow! - a.capitalExpenditure!);
    if (a.capitalExpenditure != null) assert.ok(a.capitalExpenditure >= 0);
  }
  assert.equal(l.freeCashFlow, f.annual.at(-1)!.freeCashFlow);
  if (symbol === "AAPL") assert.ok(f.balance.shortTermInvestments! > 0, "Apple : placements inclus");
  if (symbol === "RIVN") assert.ok(l.freeCashFlow! < 0, "Rivian : FCF négatif");
}
console.log("\nSEC : OK");
