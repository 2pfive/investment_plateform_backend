import axios from "axios";
import { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma.js";

/**
 * ============================================================
 * COMPTES DES SOCIÉTÉS — SEC EDGAR
 * ============================================================
 *
 * Source officielle, gratuite et sans clé : les comptes que chaque société
 * cotée aux États-Unis dépose auprès de la SEC (10-K annuel, 10-Q
 * trimestriel), au format XBRL.
 *
 * Difficulté : un même chiffre porte des noms différents selon la société et
 * l'année (Apple a quitté `Revenues` en 2018 pour `RevenueFromContract…`).
 * Chaque indicateur a donc une liste de noms possibles, et on retient la
 * valeur la plus récente parmi eux. Un chiffre introuvable reste absent :
 * jamais d'estimation.
 *
 * Couverture : très bonne sur les sociétés américaines. Les sociétés
 * étrangères en normes IFRS (TSM, ASML) et les ETF n'ont pas ces données.
 *
 * Politique SEC : User-Agent avec contact obligatoire (`SEC_USER_AGENT`),
 * 10 requêtes/seconde au plus.
 */

const USER_AGENT =
  process.env.SEC_USER_AGENT ||
  process.env.WIKIMEDIA_USER_AGENT ||
  "AmaraBackend/1.0 (investment platform; contact via repository owner)";

const http = axios.create({ timeout: 15_000, headers: { "User-Agent": USER_AGENT } });

/** Les comptes changent une fois par trimestre : une relecture par jour suffit. */
const FRESH_MS = 24 * 60 * 60_000;
const MISSING_RETRY_MS = 7 * 24 * 60 * 60_000;
const TICKERS_TTL_MS = 24 * 60 * 60_000;

/** Nombre d'exercices gardés pour l'onglet Croissance. */
const YEARS = 6;

/**
 * Version du résumé stocké en cache. À incrémenter dès que `CompanyFigures`
 * change : les fiches d'une version antérieure sont relues à la SEC au lieu
 * d'attendre 24 h.
 */
const FIGURES_VERSION = 2;

/**
 * Pas de bénéfice PAR ACTION : la SEC ne recalcule pas les années antérieures
 * à une division d'actions (Netflix passe de 9,95 $ à 1,20 $ en 2023, sans
 * que rien ne se soit effondré). Les totaux, eux, ne bougent pas.
 */
export interface AnnualFigures {
  /** Année de clôture de l'exercice. */
  year: number;
  /** Date de clôture, « 2025-12-31 ». */
  end: string;
  revenue: number | null;
  netIncome: number | null;
  /** Argent encaissé par l'activité (flux de trésorerie d'exploitation). */
  operatingCashFlow: number | null;
  /** Investissements de l'exercice (usines, matériel…), en valeur positive. */
  capitalExpenditure: number | null;
  /** Exploitation − investissements. `null` si l'un des deux manque. */
  freeCashFlow: number | null;
}

/** Dividende versé par action, en dollars. */
export interface DividendPoint {
  /** Fin de la période : exercice (« 2025-09-27 ») ou trimestre. */
  end: string;
  perShare: number;
}

export interface DividendHistory {
  /** Par exercice, du plus ancien au plus récent. */
  yearly: DividendPoint[];
  /** Par trimestre, du plus ancien au plus récent. */
  quarterly: DividendPoint[];
}

/** Résumé des comptes, en dollars. Ce qui est stocké en cache. */
export interface CompanyFigures {
  version: number;
  cik: number;
  /** Exercices annuels, du plus ancien au plus récent. */
  annual: AnnualFigures[];
  /** Dernier exercice publié. */
  latest: {
    end: string;
    revenue: number | null;
    netIncome: number | null;
    operatingCashFlow: number | null;
    capitalExpenditure: number | null;
    freeCashFlow: number | null;
    /** Total versé aux actionnaires sur l'exercice. */
    dividendsPaid: number | null;
  } | null;
  /** Bilan le plus récent (trimestriel ou annuel). */
  balance: {
    end: string | null;
    /** Trésorerie + placements à court terme, à la même date. */
    cash: number | null;
    /** Dont placements à court terme ; `null` si aucun n'est publié à cette date. */
    shortTermInvestments: number | null;
    /** Dette financière, hors contrats de location. */
    debt: number | null;
    equity: number | null;
  };
  sharesOutstanding: number | null;
  /** `null` : aucun dividende par action publié (ou société qui n'en verse pas). */
  dividends: DividendHistory | null;
}

/* --- Lecture du XBRL --- */

interface Fact {
  start?: string;
  end: string;
  val: number;
  form: string;
  filed: string;
  accn: string;
}
type Concepts = Record<string, { units?: Record<string, Fact[]> }>;

/** Exercice complet : entre 350 et 380 jours. */
function isYear(f: Fact): boolean {
  if (!f.start) return false;
  const days = (Date.parse(f.end) - Date.parse(f.start)) / 86_400_000;
  return days > 350 && days < 380;
}

const annualForm = (f: Fact) => f.form === "10-K" || f.form === "10-K/A";
const periodicForm = (f: Fact) => annualForm(f) || f.form === "10-Q" || f.form === "10-Q/A";

function facts(concepts: Concepts, name: string, unit: string): Fact[] {
  return concepts[name]?.units?.[unit] ?? [];
}

/**
 * Valeurs annuelles par date de clôture.
 *
 * Pour une même clôture, on garde la publication la PLUS RÉCENTE : chaque
 * rapport annuel reprend les années précédentes, corrigées s'il le faut —
 * notamment après une correction comptable.
 */
function annualSeries(concepts: Concepts, name: string, unit: string): Map<string, number> {
  const latestByEnd = new Map<string, Fact>();
  for (const f of facts(concepts, name, unit)) {
    if (!annualForm(f) || !isYear(f)) continue;
    const known = latestByEnd.get(f.end);
    if (!known || f.filed > known.filed) latestByEnd.set(f.end, f);
  }
  return new Map([...latestByEnd].map(([end, f]) => [end, f.val]));
}

/** Valeur de bilan la plus récente parmi plusieurs noms possibles. */
function latestInstant(concepts: Concepts, names: string[]): { end: string; val: number } | null {
  let best: Fact | null = null;
  for (const name of names) {
    for (const f of facts(concepts, name, "USD")) {
      if (!periodicForm(f) || f.start) continue;
      if (!best || f.end > best.end || (f.end === best.end && f.filed > best.filed)) best = f;
    }
  }
  return best ? { end: best.end, val: best.val } : null;
}

/**
 * Dette financière. Certaines sociétés publient le total (`LongTermDebt`),
 * d'autres seulement les parts à plus et à moins d'un an. On retient la
 * présentation la plus récente.
 */
function debt(concepts: Concepts): { end: string; val: number } | null {
  const total = latestInstant(concepts, ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"]);
  const noncurrent = latestInstant(concepts, ["LongTermDebtNoncurrent"]);
  const current = latestInstant(concepts, ["LongTermDebtCurrent", "DebtCurrent"]);
  const split = noncurrent
    ? {
        end: noncurrent.end,
        val: noncurrent.val + (current && current.end === noncurrent.end ? current.val : 0)
      }
    : null;
  if (total && split) return total.end >= split.end ? total : split;
  return total ?? split;
}

/**
 * Nombre d'actions en circulation, toutes catégories confondues (Alphabet en
 * a trois). Page de garde du dernier rapport, sinon moyenne diluée.
 */
function shares(all: { dei?: Concepts; "us-gaap"?: Concepts }): number | null {
  const cover = all.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? [];
  const last = cover.at(-1);
  if (last) {
    return cover.filter((f) => f.accn === last.accn).reduce((sum, f) => sum + f.val, 0);
  }
  const diluted = facts(all["us-gaap"] ?? {}, "WeightedAverageNumberOfDilutedSharesOutstanding", "shares")
    .filter(periodicForm)
    .sort((a, b) => a.end.localeCompare(b.end) || a.filed.localeCompare(b.filed));
  return diluted.at(-1)?.val ?? null;
}

const DPS = ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"];
const QUARTERS_KEPT = 8;

const days = (f: Fact) => (Date.parse(f.end) - Date.parse(f.start!)) / 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Dividende par action, par exercice et par trimestre.
 *
 * Les rapports trimestriels (10-Q) donnent les trois premiers trimestres ;
 * le quatrième n'existe que noyé dans le rapport annuel. On le retrouve par
 * soustraction : exercice complet − neuf premiers mois. Les trimestres ainsi
 * reconstitués sont arrondis au centime, comme les dividendes eux-mêmes.
 *
 * Un dividende « déclaré » est annoncé par l'entreprise ; il est versé
 * quelques semaines plus tard. Les deux étiquettes existent selon les
 * sociétés, on prend la première qui a des valeurs.
 */
export function dividendHistory(concepts: Concepts): DividendHistory | null {
  // L'étiquette la plus récente l'emporte : Coca-Cola a publié « déclaré »
  // jusqu'en 2018, puis « versé » — le premier de la liste serait périmé.
  const lastEnd = (n: string) =>
    facts(concepts, n, "USD/shares").reduce((max, f) => (f.end > max ? f.end : max), "");
  const name = DPS.filter((n) => lastEnd(n)).sort((a, b) => lastEnd(b).localeCompare(lastEnd(a)))[0];
  if (!name) return null;
  const all = facts(concepts, name, "USD/shares").filter((f) => f.start && periodicForm(f));

  // Dernière publication de chaque période (début → fin).
  const latest = new Map<string, Fact>();
  for (const f of all) {
    const key = `${f.start}|${f.end}`;
    const known = latest.get(key);
    if (!known || f.filed > known.filed) latest.set(key, f);
  }
  const periods = [...latest.values()];

  const yearly = periods
    .filter((f) => annualForm(f) && isYear(f))
    .map((f) => ({ end: f.end, perShare: f.val, start: f.start! }))
    .sort((a, b) => a.end.localeCompare(b.end));

  const quarterly = new Map<string, number>();
  for (const f of periods) {
    if (days(f) > 80 && days(f) < 100) quarterly.set(f.end, f.val);
  }
  // Quatrième trimestre : exercice − neuf premiers mois (même date de début).
  for (const y of yearly) {
    const nine = periods.find((f) => f.start === y.start && days(f) > 255 && days(f) < 290);
    if (nine && !quarterly.has(y.end)) quarterly.set(y.end, round2(y.perShare - nine.val));
  }

  if (!yearly.length && !quarterly.size) return null;
  return {
    yearly: yearly.slice(-3).map(({ end, perShare }) => ({ end, perShare })),
    quarterly: [...quarterly]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-QUARTERS_KEPT)
      .map(([end, perShare]) => ({ end, perShare }))
  };
}

const REVENUE = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet"
];
const NET_INCOME = ["NetIncomeLoss", "ProfitLoss"];

const CASH = ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"];
/**
 * Placements à court terme : trois étiquettes pour la même ligne du bilan
 * (Apple publie `MarketableSecuritiesCurrent`, d'autres `ShortTermInvestments`).
 * Une société n'en utilise qu'une ; on en retient UNE seule valeur, jamais la
 * somme, pour ne pas compter deux fois la même ligne.
 */
const SHORT_TERM_INVESTMENTS = [
  "ShortTermInvestments",
  "MarketableSecuritiesCurrent",
  "AvailableForSaleSecuritiesDebtSecuritiesCurrent"
];

/**
 * Argent disponible = trésorerie + placements à court terme. Les placements
 * ne s'ajoutent que s'ils sont arrêtés à la même date que la trésorerie :
 * additionner deux bilans différents n'aurait pas de sens.
 */
export function cashPosition(concepts: Concepts): {
  end: string;
  cash: number;
  shortTermInvestments: number | null;
} | null {
  const cash = latestInstant(concepts, CASH);
  if (!cash) return null;
  const invested = latestInstant(concepts, SHORT_TERM_INVESTMENTS);
  const sameDate = invested && invested.end === cash.end ? invested.val : null;
  return { end: cash.end, cash: cash.val + (sameDate ?? 0), shortTermInvestments: sameDate };
}

/**
 * Argent réellement dégagé : exploitation − investissements. Les sociétés
 * publient les investissements en positif (un paiement) ; la valeur absolue
 * protège d'un signe inattendu. Une donnée absente n'est jamais prise pour 0.
 */
export function freeCashFlow(operating: number | null, capex: number | null): number | null {
  return operating != null && capex != null ? operating - Math.abs(capex) : null;
}

/**
 * Plusieurs noms pour un même chiffre : on prend, clôture par clôture, le
 * premier qui a une valeur. Un nom abandonné depuis des années (Apple et
 * `Revenues`) ne masque donc pas son remplaçant sur les exercices récents.
 */
function merged(concepts: Concepts, names: string[], unit = "USD"): Map<string, number> {
  const out = new Map<string, number>();
  for (const name of names) {
    for (const [end, val] of annualSeries(concepts, name, unit)) {
      if (!out.has(end)) out.set(end, val);
    }
  }
  return out;
}

export function summarize(cik: number, all: { dei?: Concepts; "us-gaap"?: Concepts }): CompanyFigures | null {
  const gaap = all["us-gaap"];
  if (!gaap) return null;

  const revenue = merged(gaap, REVENUE);
  const netIncome = merged(gaap, NET_INCOME);
  const operating = merged(gaap, ["NetCashProvidedByUsedInOperatingActivities"]);
  const capex = merged(gaap, [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets",
    "PaymentsToAcquireProductiveAssets"
  ]);
  const dividends = merged(gaap, ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"]);

  // Clôtures connues, du plus ancien au plus récent. Le résultat net est
  // le seul chiffre que toute société publie, d'où son rôle de référence.
  const ends = [...new Set([...netIncome.keys(), ...revenue.keys()])].sort();
  const annual = ends.slice(-YEARS).map((end) => {
    const capitalExpenditure = capex.has(end) ? Math.abs(capex.get(end)!) : null;
    return {
      year: Number(end.slice(0, 4)),
      end,
      revenue: revenue.get(end) ?? null,
      netIncome: netIncome.get(end) ?? null,
      operatingCashFlow: operating.get(end) ?? null,
      capitalExpenditure,
      freeCashFlow: freeCashFlow(operating.get(end) ?? null, capitalExpenditure)
    };
  });

  const lastEnd = ends.at(-1);
  const last = annual.at(-1);
  const cash = cashPosition(gaap);
  const owed = debt(gaap);
  const equity = latestInstant(gaap, [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
  ]);

  return {
    version: FIGURES_VERSION,
    cik,
    annual,
    latest: lastEnd
      ? {
          end: lastEnd,
          revenue: revenue.get(lastEnd) ?? null,
          netIncome: netIncome.get(lastEnd) ?? null,
          operatingCashFlow: last?.operatingCashFlow ?? null,
          capitalExpenditure: last?.capitalExpenditure ?? null,
          freeCashFlow: last?.freeCashFlow ?? null,
          // Absent du rapport = rien versé, pour une société qui publie
          // ses flux de trésorerie.
          dividendsPaid: dividends.get(lastEnd) ?? (operating.has(lastEnd) ? 0 : null)
        }
      : null,
    balance: {
      end: [cash?.end, owed?.end, equity?.end].filter(Boolean).sort().at(-1) ?? null,
      cash: cash?.cash ?? null,
      shortTermInvestments: cash?.shortTermInvestments ?? null,
      debt: owed?.val ?? null,
      equity: equity?.val ?? null
    },
    sharesOutstanding: shares(all),
    dividends: dividendHistory(gaap)
  };
}

/* --- Service --- */

export class SecFundamentalsService {
  private readonly prisma: typeof defaultPrisma;
  private tickers: { expiresAt: number; map: Map<string, number> } | null = null;
  private readonly inFlight = new Map<string, Promise<CompanyFigures | null>>();

  constructor(deps: { prisma?: typeof defaultPrisma } = {}) {
    this.prisma = deps.prisma ?? defaultPrisma;
  }

  /** Comptes résumés d'un symbole, `null` si la SEC n'en a pas. */
  async figures(symbol: string): Promise<CompanyFigures | null> {
    const row = await this.prisma.companyFundamentals.findUnique({ where: { symbol } });
    const age = row ? Date.now() - row.fetchedAt.getTime() : Infinity;
    // Fiche d'un format antérieur : relue une fois, au lieu d'attendre 24 h.
    const current = !row?.data || (row.data as { version?: number }).version === FIGURES_VERSION;
    if (row && age < (row.data ? FRESH_MS : MISSING_RETRY_MS) && current) {
      return (row.data as unknown as CompanyFigures | null) ?? null;
    }

    let job = this.inFlight.get(symbol);
    if (!job) {
      job = this.refresh(symbol)
        .catch((error) => {
          console.warn("[sec] lecture des comptes en échec :", (error as Error)?.name || "erreur");
          // SEC indisponible : les comptes en cache, même anciens.
          return (row?.data as unknown as CompanyFigures | null) ?? null;
        })
        .finally(() => this.inFlight.delete(symbol));
      this.inFlight.set(symbol, job);
    }
    return job;
  }

  private async refresh(symbol: string): Promise<CompanyFigures | null> {
    const cik = (await this.tickerMap()).get(secTicker(symbol));
    let figures: CompanyFigures | null = null;
    if (cik) {
      const { data } = await http.get(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`,
        { validateStatus: (s) => s === 200 || s === 404 }
      );
      figures = data?.facts ? summarize(cik, data.facts) : null;
    }

    const data = figures ? (figures as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
    await this.prisma.companyFundamentals.upsert({
      where: { symbol },
      create: { symbol, cik: cik ?? null, data, fetchedAt: new Date() },
      update: { cik: cik ?? null, data, fetchedAt: new Date() }
    });
    return figures;
  }

  /** Symbole → CIK (identifiant SEC), liste officielle relue une fois par jour. */
  private async tickerMap(): Promise<Map<string, number>> {
    if (this.tickers && this.tickers.expiresAt > Date.now()) return this.tickers.map;
    const { data } = await http.get("https://www.sec.gov/files/company_tickers.json");
    const map = new Map<string, number>();
    for (const row of Object.values(data ?? {}) as { ticker: string; cik_str: number }[]) {
      if (!map.has(row.ticker)) map.set(row.ticker, row.cik_str);
    }
    this.tickers = { expiresAt: Date.now() + TICKERS_TTL_MS, map };
    return map;
  }
}

/** Alpaca écrit « BRK.B », la SEC « BRK-B ». */
function secTicker(symbol: string): string {
  return symbol.replace(/\./g, "-");
}
