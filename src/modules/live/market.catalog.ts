import type { BrokerAsset, BrokerContext, BrokerProvider } from "@/ports/broker.port.js";

/**
 * ============================================================
 * UNIVERS DE MARCHÉ — actions et ETF proposés à l'écran Marchés
 * ============================================================
 *
 * Tout l'univers négociable d'Alpaca (~11 000 lignes hors OTC), classé du plus
 * au moins échangé en dollars à la dernière séance. La liste est gardée en
 * mémoire et reconstruite deux fois par jour : elle coûte une trentaine
 * d'appels à Alpaca, qu'on ne peut pas refaire à chaque ouverture d'écran.
 *
 * ponytail: cache par processus. Avec plusieurs instances du serveur, chacune
 * reconstruit le sien ; passer par Redis si cela devient un problème.
 */

export type MarketAssetType = "STOCK" | "ETF";

export interface ListedAsset {
  symbol: string;
  name: string;
  assetType: MarketAssetType;
  fractionable: boolean;
  /** Montant échangé à la dernière séance, en dollars. 0 si inconnu. */
  dollarVolume: number;
  /** Symbole et nom normalisés, pour la recherche. */
  haystack: string;
}

/** Places réglementées américaines. L'OTC est écarté : peu liquide, peu fiable. */
const EXCHANGES = new Set(["NYSE", "NASDAQ", "ARCA", "NYSEARCA", "BATS", "AMEX"]);

const TTL_MS = 12 * 60 * 60_000;
/** Classement indisponible (Alpaca saturé) : on réessaie bien plus tôt. */
const TTL_UNRANKED_MS = 10 * 60_000;

/**
 * Alpaca ne dit pas si un actif est un ETF. On le déduit du nom : les fonds
 * cotés portent presque toujours « ETF », « ETN » ou « Fund », et les gammes
 * qui ne le font pas (« SPDR Gold Shares », « ProShares UltraPro QQQ ») sont
 * reconnues par leur émetteur. Les émetteurs eux-mêmes cotés en Bourse
 * (Invesco, WisdomTree, Franklin…) ne sont pas reconnus à leur seul nom :
 * leur propre action serait sinon rangée parmi les ETF. D'où la règle à part
 * pour « Invesco QQQ Trust », qui ne contient aucun des mots attendus.
 */
export function classify(name: string): MarketAssetType {
  return /\b(ETF|ETN|Fund)\b/i.test(name) ||
    /^(iShares|SPDR|Vanguard|ProShares|Direxion)\b/i.test(name) ||
    /^Invesco\b.*\bTrust\b/i.test(name)
    ? "ETF"
    : "STOCK";
}

/**
 * Nom lisible : « Apple Inc. Common Stock » devient « Apple Inc. ». La
 * catégorie de titre n'apprend rien à l'utilisateur ; la classe, si.
 */
export function displayName(name: string): string {
  return name
    .replace(/\s+(Class [A-Z])?\s*(Common Stock|Ordinary Shares|Common Shares|Capital Stock|American Depositary Shares|Sponsored ADR)\b.*$/i, (_m, cls) =>
      cls ? ` ${cls}` : ""
    )
    .trim();
}

/** Même normalisation que la recherche du mobile : lettres et chiffres, sans accents. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");
}

function toListed(asset: BrokerAsset, volumes: Map<string, number>): ListedAsset {
  const name = displayName(asset.name) || asset.symbol;
  return {
    symbol: asset.symbol,
    name,
    assetType: classify(asset.name),
    fractionable: asset.fractionable,
    dollarVolume: volumes.get(asset.symbol) ?? 0,
    haystack: `${normalize(asset.symbol)} ${normalize(name)}`
  };
}

export class MarketCatalog {
  private cache = new Map<string, { expiresAt: number; listed: ListedAsset[] }>();
  private pending = new Map<string, Promise<ListedAsset[]>>();

  /** Univers classé, construit au premier appel puis servi depuis la mémoire. */
  async universe(context: BrokerContext, provider: BrokerProvider): Promise<ListedAsset[]> {
    const key = context.environment;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.listed;

    // Plusieurs écrans ouverts en même temps : une seule reconstruction.
    let build = this.pending.get(key);
    if (!build) {
      build = this.build(context, provider, key).finally(() => this.pending.delete(key));
      this.pending.set(key, build);
    }
    return build;
  }

  private async build(context: BrokerContext, provider: BrokerProvider, key: string) {
    const assets = (await provider.listAssets(context)).filter(
      (a) => a.active && a.tradable && a.exchange !== null && EXCHANGES.has(a.exchange)
    );

    // Sans classement, la liste reste utilisable (et cherchable) : mieux
    // qu'un écran vide parce qu'Alpaca a refusé un appel de volumes.
    const volumes = await provider
      .getDollarVolumes(context, assets.map((a) => a.symbol))
      .catch((error) => {
        console.warn("[market] classement indisponible :", (error as Error)?.name || "erreur");
        return new Map<string, number>();
      });

    const listed = assets
      .map((a) => toListed(a, volumes))
      .sort((a, b) => b.dollarVolume - a.dollarVolume || a.symbol.localeCompare(b.symbol));

    this.cache.set(key, {
      expiresAt: Date.now() + (volumes.size ? TTL_MS : TTL_UNRANKED_MS),
      listed
    });
    return listed;
  }
}

/**
 * Filtre l'univers pour une recherche. Sans recherche : l'ordre de
 * popularité. Avec : symbole exact, puis symbole qui commence par la
 * recherche, puis nom qui la contient — à pertinence égale, le plus échangé
 * d'abord (l'univers est déjà trié ainsi, et le tri est stable).
 */
export function search(listed: ListedAsset[], type: MarketAssetType, query: string): ListedAsset[] {
  const ofType = listed.filter((a) => a.assetType === type);
  const needle = normalize(query);
  if (!needle) return ofType;

  const score = (a: ListedAsset) => {
    const symbol = normalize(a.symbol);
    if (symbol === needle) return 3;
    if (symbol.startsWith(needle)) return 2;
    return a.haystack.includes(needle) ? 1 : 0;
  };

  return ofType
    .map((asset) => ({ asset, score: score(asset) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.asset);
}
