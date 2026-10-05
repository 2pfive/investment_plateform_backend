import axios from "axios";
import { prisma as defaultPrisma } from "@/lib/prisma.js";

/**
 * ============================================================
 * FICHES D'ENTREPRISE — Wikidata et Wikipédia
 * ============================================================
 *
 * Sources gratuites et sans clé. Wikidata (CC0) donne les faits : logo,
 * effectifs, siège, secteur, date d'introduction, site. Wikipédia (CC BY-SA)
 * donne l'introduction de l'article, en français quand il existe — à afficher
 * avec la mention de la source.
 *
 * Couverture : très bonne sur les grandes capitalisations, faible sur les
 * petites, quasi nulle sur les ETF. Un champ absent reste absent.
 *
 * Tout est mis en cache dans `market_data.company_profiles` et relu au plus
 * une fois par mois. `descriptionFr`, saisie à la main, n'est jamais écrasée.
 *
 * Politique Wikimedia : un User-Agent identifiant l'application et un contact
 * est obligatoire — `WIKIMEDIA_USER_AGENT`.
 */

const USER_AGENT =
  process.env.WIKIMEDIA_USER_AGENT || "AmaraBackend/1.0 (investment platform; contact via repository owner)";

const http = axios.create({ timeout: 10_000, headers: { "User-Agent": USER_AGENT } });

const FRESH_MS = 30 * 24 * 60 * 60_000;
/** Introuvable sur Wikidata : on retente plus tôt, la base s'enrichit vite. */
const MISSING_RETRY_MS = 7 * 24 * 60 * 60_000;

/** NYSE et Nasdaq. Sans ce filtre, « T » renverrait aussi Telus (Toronto). */
const EXCHANGES = ["Q13677", "Q82059"];

export interface CompanyProfileView {
  symbol: string;
  name: string | null;
  logoUrl: string | null;
  industry: string | null;
  employees: number | null;
  headquarters: string | null;
  ipoDate: string | null;
  website: string | null;
  /** Description à afficher, et sa provenance. */
  description: string | null;
  descriptionSource: "AMARA" | "WIKIPEDIA" | null;
  /** Lien vers l'article, à citer quand la description vient de Wikipédia. */
  sourceUrl: string | null;
}

/* --- Lecture des déclarations Wikidata --- */

interface Snak {
  datavalue?: { value: unknown };
}
interface Claim {
  rank: "preferred" | "normal" | "deprecated";
  mainsnak: Snak;
  qualifiers?: Record<string, Snak[]>;
}
interface Entity {
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string }>;
  labels?: Record<string, { value: string }>;
}
type WikiTime = { time: string; precision: number };

/** Déclarations retenues : les « préférées » s'il y en a, sinon les normales. */
function best(entity: Entity, property: string): Claim[] {
  const usable = (entity.claims?.[property] ?? []).filter(
    (c) => c.rank !== "deprecated" && c.mainsnak.datavalue
  );
  const preferred = usable.filter((c) => c.rank === "preferred");
  return preferred.length ? preferred : usable;
}

const value = <T>(claim: Claim | undefined) => claim?.mainsnak.datavalue?.value as T | undefined;
const qualifier = <T>(claim: Claim, property: string) =>
  claim.qualifiers?.[property]?.[0]?.datavalue?.value as T | undefined;
const entityId = (claim: Claim | undefined) => value<{ id: string }>(claim)?.id;

/** « +1980-12-12T00:00:00Z » à la précision du jour, du mois ou de l'année. */
function formatTime(t: WikiTime | undefined): string | null {
  if (!t) return null;
  const date = t.time.replace(/^\+/, "").slice(0, 10);
  if (t.precision >= 11) return date;
  if (t.precision === 10) return date.slice(0, 7);
  return date.slice(0, 4);
}

/** Effectif le plus récent : l'historique des effectifs est souvent complet. */
function latestEmployees(entity: Entity): number | null {
  const dated = best(entity, "P1128")
    .map((c) => ({
      amount: Number(value<{ amount: string }>(c)?.amount),
      at: qualifier<WikiTime>(c, "P585")?.time ?? ""
    }))
    .filter((e) => Number.isFinite(e.amount))
    .sort((a, b) => b.at.localeCompare(a.at));
  return dated[0]?.amount ?? null;
}

/** Date de cotation sur NYSE ou Nasdaq, pour ce symbole. */
function listingDate(entity: Entity, symbol: string): string | null {
  const listing = (entity.claims?.P414 ?? []).find(
    (c) =>
      EXCHANGES.includes(entityId(c) ?? "") &&
      qualifier<string>(c, "P249")?.toUpperCase() === symbol
  );
  return listing ? formatTime(qualifier<WikiTime>(listing, "P580")) : null;
}

/** Vignette PNG d'un logo de Commons (souvent un SVG à l'origine). */
function logoUrl(file: string | undefined): string | null {
  return file
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=128`
    : null;
}

/**
 * Site principal, sans protocole : « www.apple.com », comme les fiches
 * existantes. Plusieurs sites (un par pays) : le plus court est le site
 * racine, « apple.com » plutôt que « apple.com/at ».
 */
function website(entity: Entity): string | null {
  const urls = best(entity, "P856")
    .flatMap((c) => value<string>(c) ?? [])
    .map((url) => url.replace(/^https?:\/\//, "").replace(/\/$/, ""))
    .sort((a, b) => a.length - b.length);
  return urls[0] ?? null;
}

/**
 * Retire les transcriptions phonétiques (« Apple Inc. [ˈæpəl] »,
 * « (/ˈmaɪkɹəˌsɔft/) ») et les parenthèses vides qu'elles laissent : utiles
 * dans une encyclopédie, du bruit dans une fiche d'investissement.
 */
const IPA = /[ˈˌəɹɝɚæθðʃʒŋɔʊɪ]/;
function cleanSummary(text: string | undefined): string | null {
  if (!text) return null;
  return (
    text
      .replace(/\[[^\]]*\]/g, (m) => (IPA.test(m) ? "" : m))
      .replace(/\([^()]*\)/g, (m) => (IPA.test(m) ? "" : m))
      .replace(/\/[^/\s][^/]*\//g, (m) => (IPA.test(m) ? "" : m))
      .replace(/\(\s*\)/g, "")
      .replace(/[ 	]{2,}/g, " ")
      .replace(/ ([,.])/g, "$1")
      .trim() || null
  );
}

/* --- Appels Wikimedia --- */

/** Symbole → entité Wikidata, pour les cotations en cours sur NYSE / Nasdaq. */
async function findEntities(symbols: string[]): Promise<Map<string, string>> {
  const query = `
    SELECT ?ticker ?item WHERE {
      VALUES ?ticker { ${symbols.map((s) => JSON.stringify(s)).join(" ")} }
      VALUES ?exchange { ${EXCHANGES.map((q) => `wd:${q}`).join(" ")} }
      ?item p:P414 ?listing .
      ?listing pq:P249 ?ticker ; ps:P414 ?exchange .
      FILTER NOT EXISTS { ?listing pq:P582 ?end }
    }`;
  const { data } = await http.get("https://query.wikidata.org/sparql", {
    params: { query },
    headers: { Accept: "application/sparql-results+json" }
  });
  const found = new Map<string, string>();
  for (const row of data?.results?.bindings ?? []) {
    const ticker = String(row.ticker?.value ?? "");
    const id = String(row.item?.value ?? "").split("/").pop();
    // Plusieurs entités pour un symbole (société mère et filiale) : la
    // première suffit, l'ambiguïté est rare sur une cotation en cours.
    if (ticker && id && !found.has(ticker)) found.set(ticker, id);
  }
  return found;
}

/** `wbgetentities`, par lots de 50 (limite de l'API). */
async function getEntities(ids: string[], props: string): Promise<Record<string, Entity>> {
  const entities: Record<string, Entity> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = await http.get("https://www.wikidata.org/w/api.php", {
      params: {
        action: "wbgetentities",
        ids: ids.slice(i, i + 50).join("|"),
        props,
        languages: "fr|en",
        sitefilter: "frwiki|enwiki",
        format: "json"
      }
    });
    Object.assign(entities, data?.entities ?? {});
  }
  return entities;
}

/** Introductions d'articles, en texte brut, par lots de 20 (limite de l'API). */
async function getSummaries(lang: "fr" | "en", titles: string[]): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  for (let i = 0; i < titles.length; i += 20) {
    const { data } = await http.get(`https://${lang}.wikipedia.org/w/api.php`, {
      params: {
        action: "query",
        prop: "extracts",
        exintro: 1,
        explaintext: 1,
        exlimit: 20,
        titles: titles.slice(i, i + 20).join("|"),
        format: "json",
        formatversion: 2
      }
    });
    for (const page of data?.query?.pages ?? []) {
      if (page?.title && page?.extract) summaries.set(page.title, String(page.extract).trim());
    }
  }
  return summaries;
}

/* --- Service --- */

export class CompanyProfileService {
  private readonly prisma: typeof defaultPrisma;
  /**
   * Lectures Wikimedia en cours, par symbole. Deux pages ou deux écrans qui
   * demandent le même symbole attendent la même lecture.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: { prisma?: typeof defaultPrisma } = {}) {
    this.prisma = deps.prisma ?? defaultPrisma;
  }

  /** Fiche d'un symbole, lue sur Wikimedia si elle manque ou date. */
  async profile(symbol: string): Promise<CompanyProfileView | null> {
    await this.ensure([symbol]);
    const row = await this.prisma.companyProfile.findUnique({ where: { symbol } });
    return row ? toView(row) : null;
  }

  /**
   * Logos de ces symboles, lus sur Wikimedia s'ils manquent (une dizaine de
   * secondes pour 30 symboles inconnus, instantané ensuite).
   */
  async logos(symbols: string[]): Promise<Map<string, string>> {
    await this.ensure(symbols);
    return this.knownLogos(symbols);
  }

  /** Logos déjà en base, sans aucun appel à Wikimedia. */
  async knownLogos(symbols: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.companyProfile.findMany({
      where: { symbol: { in: symbols }, logoUrl: { not: null } },
      select: { symbol: true, logoUrl: true }
    });
    return new Map(rows.map((r) => [r.symbol, r.logoUrl!]));
  }

  /** Lit sur Wikimedia les fiches manquantes ou périmées, et attend. */
  private async ensure(symbols: string[]): Promise<void> {
    const rows = await this.prisma.companyProfile.findMany({
      where: { symbol: { in: symbols } },
      select: { symbol: true, wikidataId: true, fetchedAt: true }
    });
    const known = new Map(rows.map((r) => [r.symbol, r]));
    const stale = symbols.filter((s) => {
      const row = known.get(s);
      return !row || this.isStale(row);
    });

    const pending = stale.flatMap((s) => this.inFlight.get(s) ?? []);
    const fresh = stale.filter((s) => !this.inFlight.has(s));
    if (fresh.length) {
      const job = this.refresh(fresh)
        // Wikimedia indisponible : la fiche en cache, même ancienne, vaut
        // mieux qu'une erreur.
        .catch((error) =>
          console.warn("[profile] Wikimedia indisponible :", (error as Error)?.name || "erreur")
        )
        .finally(() => fresh.forEach((s) => this.inFlight.delete(s)));
      fresh.forEach((s) => this.inFlight.set(s, job));
      pending.push(job);
    }
    await Promise.all(pending);
  }

  private isStale(row: { wikidataId: string | null; fetchedAt: Date }): boolean {
    const age = Date.now() - row.fetchedAt.getTime();
    return age > (row.wikidataId ? FRESH_MS : MISSING_RETRY_MS);
  }

  /** Lit les fiches sur Wikimedia et les enregistre. */
  private async refresh(symbols: string[]): Promise<void> {
    const found = await findEntities(symbols);
    const ids = [...new Set(found.values())];
    const entities = ids.length ? await getEntities(ids, "claims|sitelinks|labels") : {};

    // Siège, pays, secteur : des entités à part, dont il faut le libellé.
    const labelIds = new Set<string>();
    for (const entity of Object.values(entities)) {
      for (const p of ["P159", "P17", "P452"]) {
        const id = entityId(best(entity, p)[0]);
        if (id) labelIds.add(id);
      }
    }
    const labelled = labelIds.size ? await getEntities([...labelIds], "labels") : {};
    const label = (id: string | undefined) =>
      id ? (labelled[id]?.labels?.fr?.value ?? labelled[id]?.labels?.en?.value ?? null) : null;

    const titleFr = (e: Entity) => e.sitelinks?.frwiki?.title;
    const titleEn = (e: Entity) => e.sitelinks?.enwiki?.title;
    const all = Object.values(entities);
    const [summariesFr, summariesEn] = await Promise.all([
      getSummaries("fr", all.flatMap((e) => titleFr(e) ?? [])),
      getSummaries("en", all.flatMap((e) => titleEn(e) ?? []))
    ]);

    const now = new Date();
    for (const symbol of symbols) {
      const id = found.get(symbol);
      const entity = id ? entities[id] : undefined;

      const hq = label(entityId(best(entity ?? {}, "P159")[0]));
      const country = label(entityId(best(entity ?? {}, "P17")[0]));
      const fr = entity && titleFr(entity);
      const en = entity && titleEn(entity);

      const data = entity
        ? {
            wikidataId: id!,
            name: entity.labels?.fr?.value ?? entity.labels?.en?.value ?? null,
            logoUrl: logoUrl(value<string>(best(entity, "P154")[0])),
            industry: label(entityId(best(entity, "P452")[0])),
            employees: latestEmployees(entity),
            headquarters: [hq, country].filter(Boolean).join(", ") || null,
            ipoDate: listingDate(entity, symbol),
            website: website(entity),
            wikiTitleFr: fr ?? null,
            summaryFr: cleanSummary(fr ? summariesFr.get(fr) : undefined),
            summaryEn: cleanSummary(en ? summariesEn.get(en) : undefined),
            fetchedAt: now
          }
        : { wikidataId: null, fetchedAt: now };

      // `descriptionFr` n'apparaît jamais ici : c'est la traduction saisie
      // à la main, elle survit à tous les rafraîchissements.
      await this.prisma.companyProfile.upsert({
        where: { symbol },
        create: { symbol, ...data },
        update: data
      });
    }
  }
}

function toView(row: {
  symbol: string;
  name: string | null;
  logoUrl: string | null;
  industry: string | null;
  employees: number | null;
  headquarters: string | null;
  ipoDate: string | null;
  website: string | null;
  wikiTitleFr: string | null;
  summaryFr: string | null;
  descriptionFr: string | null;
}): CompanyProfileView {
  // Ordre : texte de l'équipe, puis Wikipédia FR. Pas de repli sur l'anglais :
  // l'application est en français, et le texte anglais reste en base comme
  // matière à traduire (`summary_en`).
  const fromWiki = !row.descriptionFr && !!row.summaryFr;
  return {
    symbol: row.symbol,
    name: row.name,
    logoUrl: row.logoUrl,
    industry: row.industry,
    employees: row.employees,
    headquarters: row.headquarters,
    ipoDate: row.ipoDate,
    website: row.website,
    description: row.descriptionFr ?? row.summaryFr,
    descriptionSource: row.descriptionFr ? "AMARA" : fromWiki ? "WIKIPEDIA" : null,
    sourceUrl:
      fromWiki && row.wikiTitleFr
        ? `https://fr.wikipedia.org/wiki/${encodeURIComponent(row.wikiTitleFr.replace(/ /g, "_"))}`
        : null
  };
}
