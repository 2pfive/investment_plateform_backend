import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { BrokerError } from "@/ports/broker.errors.js";
import type { BrokerProvider, HistoryRange } from "@/ports/broker.port.js";
import type { BrokerContext } from "@/ports/broker.port.js";
import { BrokerConnectionService } from "@/modules/broker/broker.service.js";
import { FxRateService } from "@/modules/fx/fx.service.js";

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
 *   GET /live/assets/:symbol
 *
 * ponytail: aucun cache serveur. Le mobile met en cache (TanStack Query) ;
 * ajouter un cache par symbole si la limite d'Alpaca (200 req/min) se fait
 * sentir avec plusieurs utilisateurs.
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
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

const broker = new BrokerConnectionService();
const fx = new FxRateService();

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

router.get(
  "/assets/:symbol",
  live(async ({ symbol }, context, provider) => {
    const asset = await provider.getAsset(context, symbol);
    if (!asset) throw new BrokerError("ASSET_NOT_FOUND", "Actif inconnu du courtier.", 404);
    return {
      symbol: asset.symbol,
      name: asset.name,
      exchange: asset.exchange,
      tradable: asset.tradable,
      fractionable: asset.fractionable
    };
  })
);

export default router;
