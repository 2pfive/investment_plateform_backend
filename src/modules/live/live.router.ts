import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { BrokerError } from "@/ports/broker.errors.js";
import type { BrokerProvider, HistoryRange } from "@/ports/broker.port.js";
import type { BrokerContext } from "@/ports/broker.port.js";
import { BrokerConnectionService } from "@/modules/broker/broker.service.js";
import { FxRateService } from "@/modules/fx/fx.service.js";
import { MarketCatalog, classify, search } from "./market.catalog.js";
import { CompanyProfileService } from "./company.profile.js";
import { SecFundamentalsService } from "./sec.fundamentals.js";

/**
 * ============================================================
 * DONNÉES EN DIRECT — compte Alpaca et marché
 * ============================================================
 *
 * Lecture seule, session obligatoire (montée sous `requireAuth`). Tout passe
 * par `withBroker` : compte partagé ou compte relié par OAuth, l'appelant ne
 * voit pas la différence. Montants en chaînes décimales, USD.
 *
 *   GET /live/account
 *   GET /live/positions
 *   GET /live/history?range=1M
 *   GET /live/quotes?symbols=SPY,AAPL
 *   GET /live/bars/:symbol?range=1J
 *   GET /live/news?symbols=AAPL&limit=10
 *   GET /live/market?type=ETF&q=gold&offset=0&limit=30
 *   GET /live/assets/:symbol
 *   GET /live/assets/:symbol/profile
 *   GET /live/assets/:symbol/fundamentals
 *   GET /live/logos?symbols=AAPL,MSFT
 *
 * ponytail: aucun cache serveur, sauf l'univers de `/market` (voir
 * `market.catalog.ts`). Le mobile met en cache (TanStack Query) ; ajouter un
 * cache par symbole si la limite d'Alpaca (200 req/min) se fait sentir avec
 * plusieurs utilisateurs.
 */

const RANGES = ["1J", "1S", "1M", "3M", "1A", "TOUT"] as const;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

const symbolList = z
  .string()
  .transform((raw) => [...new Set(raw.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean))])
  .pipe(z.array(z.string().regex(SYMBOL)).max(50));

const query = z.object({
  environment: z.string().max(8).optional(),
  range: z.enum(RANGES).default("1M"),
  symbols: symbolList.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  type: z.enum(["STOCK", "ETF"]).default("STOCK"),
  q: z.string().trim().max(40).default(""),
  offset: z.coerce.number().int().min(0).max(50_000).default(0)
});

const broker = new BrokerConnectionService();
const fx = new FxRateService();
const market = new MarketCatalog();
const profiles = new CompanyProfileService();
const sec = new SecFundamentalsService();

/** Taux de croissance annuel moyen entre deux valeurs positives, en %. */
function yearlyGrowth(first: number | null, last: number | null, years: number): number | null {
  if (!first || !last || first <= 0 || last <= 0 || years <= 0) return null;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

const round = (n: number | null, digits = 2) =>
  n == null || !Number.isFinite(n) ? null : Number(n.toFixed(digits));

type Handler = (
  input: z.infer<typeof query> & { symbol: string },
  context: BrokerContext,
  provider: BrokerProvider
) => Promise<unknown>;

/** Valide, exécute sur le compte de l'utilisateur, répond au format commun. */
function live(handler: Handler) {
  return async (req: Request, res: Response) => {
    const userId = req.user?.user_id;
    if (typeof userId !== "string" || !userId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHENTICATED", message: "Authentification requise." }
      });
    }

    const parsed = query.safeParse(req.query);
    const symbol = String(req.params.symbol ?? "").toUpperCase();
    if (!parsed.success || (req.params.symbol !== undefined && !SYMBOL.test(symbol))) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "Paramètres invalides." }
      });
    }

    try {
      const data = await broker.withBroker(userId, parsed.data.environment, (context, { provider }) =>
        handler({ ...parsed.data, symbol }, context, provider)
      );
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ success: true, data });
    } catch (error) {
      if (error instanceof BrokerError) {
        return res.status(error.statusCode).json({
          success: false,
          error: { code: error.code, message: error.message }
        });
      }
      console.error("[live] lecture en échec :", (error as Error)?.name || "erreur");
      return res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Une erreur inattendue est survenue." }
      });
    }
  };
}

const router = Router();

router.get(
  "/account",
  live(async (_input, context, provider) => {
    const account = await provider.getAccount(context);
    // Le taux n'est qu'indicatif ici : son absence ne doit pas masquer le solde.
    const xaf = await fx.quote("XAF").catch(() => null);
    return {
      accountNumber: `•••• ${account.accountNumber.slice(-4)}`,
      canTrade: account.canTrade,
      currency: account.currency,
      cashUsd: account.cash,
      buyingPowerUsd: account.buyingPower,
      equityUsd: account.equity,
      lastEquityUsd: account.lastEquity,
      fx: xaf ? { currency: "XAF", perUsd: xaf.perUsd, at: xaf.fetchedAt } : null
    };
  })
);

router.get(
  "/positions",
  live(async (_input, context, provider) => ({ positions: await provider.getPositions(context) }))
);

router.get(
  "/history",
  live(async ({ range }, context, provider) => ({
    range,
    points: await provider.getPortfolioHistory(context, range as HistoryRange)
  }))
);

router.get(
  "/quotes",
  live(async ({ symbols }, context, provider) => ({
    quotes: await provider.getSnapshots(context, symbols ?? [])
  }))
);

router.get(
  "/bars/:symbol",
  live(async ({ symbol, range }, context, provider) => ({
    symbol,
    range,
    points: await provider.getBars(context, symbol, range as HistoryRange)
  }))
);

router.get(
  "/news",
  live(async ({ symbols, limit }, context, provider) => ({
    news: await provider.getNews(context, symbols ?? [], limit)
  }))
);

/**
 * Une page de l'univers, cours compris : le mobile n'a pas à relancer
 * `/quotes` pour chaque page qu'il fait défiler.
 */
router.get(
  "/market",
  live(async ({ type, q, offset, limit }, context, provider) => {
    const listed = await market.universe(context, provider);
    const matches = search(listed, type, q);
    const page = matches.slice(offset, offset + limit);

    const [snapshots, logos] = await Promise.all([
      provider.getSnapshots(context, page.map((a) => a.symbol)),
      // Logos déjà connus seulement : la liste n'attend pas Wikimedia. Les
      // autres arrivent par `/logos`. Wikidata ne connaît presque aucun ETF.
      type === "STOCK"
        ? profiles.knownLogos(page.map((a) => a.symbol)).catch(() => new Map<string, string>())
        : new Map<string, string>()
    ]);
    const quotes = new Map(snapshots.map((s) => [s.symbol, s]));

    return {
      items: page.map((a) => {
        const quote = quotes.get(a.symbol);
        return {
          symbol: a.symbol,
          name: a.name,
          assetType: a.assetType,
          fractionable: a.fractionable,
          logoUrl: logos.get(a.symbol) ?? null,
          price: quote?.price ?? null,
          changePercent: quote?.changePercent ?? null
        };
      }),
      total: matches.length,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      // « 3 résultats dans ETF » quand la recherche ne trouve rien ici.
      otherTotal: q ? search(listed, type === "ETF" ? "STOCK" : "ETF", q).length : 0
    };
  })
);

/**
 * Chiffres, finances et croissance d'une société : comptes SEC + cours
 * Alpaca. Valeurs en NOMBRES (dollars, pourcentages) : elles servent à
 * l'affichage et ne participent à aucun ordre.
 *
 * Les ratios sont calculés sur des TOTAUX (valeur en Bourse ÷ bénéfice
 * annuel), jamais par action : une division d'actions survenue après le
 * dernier rapport fausserait sinon le calcul.
 */
router.get(
  "/assets/:symbol/fundamentals",
  live(async ({ symbol }, context, provider) => {
    const [figures, [snapshot], year] = await Promise.all([
      sec.figures(symbol),
      provider.getSnapshots(context, [symbol]),
      provider.getBars(context, symbol, "1A")
    ]);

    const price = snapshot?.price ? Number(snapshot.price) : null;
    const closes = year.map((p) => Number(p.value)).filter(Number.isFinite);
    // Symbole à catégorie (« BRK.B ») : les catégories d'une même société
    // n'ont pas la même valeur (une action A de Berkshire vaut 1 500 B). Le
    // nombre total d'actions × le cours d'une seule catégorie serait faux.
    const shares = symbol.includes(".") ? null : (figures?.sharesOutstanding ?? null);
    const marketCap = price && shares ? price * shares : null;
    const latest = figures?.latest ?? null;
    const netIncome = latest?.netIncome ?? null;

    const annual = figures?.annual ?? [];
    const withRevenue = annual.filter((a) => a.revenue != null);
    const withIncome = annual.filter((a) => a.netIncome != null);
    const span = (rows: typeof annual) => (rows.length > 1 ? rows.at(-1)!.year - rows[0].year : 0);

    return {
      symbol,
      market: {
        price,
        marketCap: round(marketCap, 0),
        // Société en perte : pas de rapport prix / bénéfices, il n'aurait
        // aucun sens. `isProfitable` le dit à l'écran.
        priceToEarnings: marketCap && netIncome && netIncome > 0 ? round(marketCap / netIncome, 1) : null,
        isProfitable: netIncome == null ? null : netIncome > 0,
        yearLow: closes.length ? Math.min(...closes) : null,
        yearHigh: closes.length ? Math.max(...closes) : null,
        dividends: figures?.dividends ?? null,
        dividendYield:
          marketCap && latest?.dividendsPaid != null
            ? round((Math.abs(latest.dividendsPaid) / marketCap) * 100)
            : null
      },
      finances: latest
        ? {
            fiscalYearEnd: latest.end,
            revenue: latest.revenue,
            netIncome,
            netMargin:
              latest.revenue && netIncome != null ? round((netIncome / latest.revenue) * 100, 1) : null,
            freeCashFlow:
              latest.operatingCashFlow != null && latest.capitalExpenditure != null
                ? latest.operatingCashFlow - latest.capitalExpenditure
                : null,
            balanceDate: figures!.balance.end,
            cash: figures!.balance.cash,
            debt: figures!.balance.debt
          }
        : null,
      growth: annual.length
        ? {
            years: annual.map((a) => ({ year: a.year, revenue: a.revenue, netIncome: a.netIncome })),
            revenuePerYear: round(
              yearlyGrowth(withRevenue[0]?.revenue ?? null, withRevenue.at(-1)?.revenue ?? null, span(withRevenue)),
              1
            ),
            netIncomePerYear: round(
              yearlyGrowth(withIncome[0]?.netIncome ?? null, withIncome.at(-1)?.netIncome ?? null, span(withIncome)),
              1
            ),
            spanYears: span(withRevenue.length ? withRevenue : withIncome)
          }
        : null,
      source: figures ? "SEC EDGAR" : null
    };
  })
);

router.get(
  "/assets/:symbol",
  live(async ({ symbol }, context, provider) => {
    const asset = await provider.getAsset(context, symbol);
    if (!asset) throw new BrokerError("ASSET_NOT_FOUND", "Actif inconnu du courtier.", 404);
    return {
      symbol: asset.symbol,
      name: asset.name,
      assetType: classify(asset.name),
      exchange: asset.exchange,
      tradable: asset.tradable,
      fractionable: asset.fractionable
    };
  })
);


/**
 * Logos d'une page de l'écran Marchés. Attend la lecture Wikimedia des
 * symboles inconnus : quelques secondes la première fois, instantané ensuite.
 */
router.get("/logos", async (req: Request, res: Response) => {
  const parsed = symbolList.safeParse(req.query.symbols ?? "");
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_REQUEST", message: "Paramètres invalides." }
    });
  }
  try {
    const logos = parsed.data.length ? await profiles.logos(parsed.data) : new Map();
    return res.status(200).json({ success: true, data: { logos: Object.fromEntries(logos) } });
  } catch (error) {
    console.error("[live] logos en échec :", (error as Error)?.name || "erreur");
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Une erreur inattendue est survenue." }
    });
  }
});

/**
 * Fiche d'entreprise (Wikidata / Wikipédia). Hors `live()` : elle ne passe
 * pas par le courtier, et une fiche absente n'est pas une erreur.
 */
router.get("/assets/:symbol/profile", async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol ?? "").toUpperCase();
  if (!SYMBOL.test(symbol)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_REQUEST", message: "Paramètres invalides." }
    });
  }
  try {
    const profile = await profiles.profile(symbol);
    return res.status(200).json({ success: true, data: { profile } });
  } catch (error) {
    console.error("[live] fiche d'entreprise en échec :", (error as Error)?.name || "erreur");
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Une erreur inattendue est survenue." }
    });
  }
});

export default router;
