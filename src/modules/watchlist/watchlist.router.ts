import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";

/**
 * ============================================================
 * ACTIFS SUIVIS
 * ============================================================
 *
 * Liste personnelle de symboles, montée sous `requireAuth`. Les cours ne sont
 * pas renvoyés ici : le mobile les lit par `/live/quotes`, comme partout.
 *
 *   GET    /watchlist            → [{ symbol, addedAt }], plus récent d'abord
 *   PUT    /watchlist/:symbol    ajoute (idempotent)
 *   DELETE /watchlist/:symbol    retire (idempotent)
 */

/** Même règle que les ordres et `/live`. */
const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.]{0,9}$/);

/** Garde-fou contre une liste sans fin, et la taille de `/live/quotes` (50). */
const MAX_ITEMS = 50;

const router = Router();

function userId(req: Request): string | null {
  const id = req.user?.user_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function error(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function internal(res: Response, err: unknown) {
  console.error("[watchlist]", (err as Error)?.name || "erreur");
  return error(res, 500, "INTERNAL_ERROR", "Une erreur inattendue est survenue.");
}

router.get("/", async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).end();

  try {
    const items = await prisma.watchlistItem.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      select: { symbol: true, createdAt: true }
    });
    return res.status(200).json({
      success: true,
      data: items.map((i) => ({ symbol: i.symbol, addedAt: i.createdAt.toISOString() }))
    });
  } catch (err) {
    return internal(res, err);
  }
});

router.put("/:symbol", async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).end();
  const symbol = symbolSchema.safeParse(req.params.symbol);
  if (!symbol.success) return error(res, 400, "INVALID_REQUEST", "Symbole invalide.");

  try {
    const exists = await prisma.watchlistItem.findUnique({
      where: { userId_symbol: { userId: id, symbol: symbol.data } },
      select: { id: true }
    });
    if (exists) return res.status(204).end();

    if ((await prisma.watchlistItem.count({ where: { userId: id } })) >= MAX_ITEMS) {
      return error(res, 409, "WATCHLIST_FULL", `Vous suivez déjà ${MAX_ITEMS} actifs.`);
    }

    // `upsert` : deux taps simultanés ne créent pas de doublon, ni d'erreur.
    await prisma.watchlistItem.upsert({
      where: { userId_symbol: { userId: id, symbol: symbol.data } },
      create: { userId: id, symbol: symbol.data },
      update: {}
    });
    return res.status(204).end();
  } catch (err) {
    return internal(res, err);
  }
});

router.delete("/:symbol", async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).end();
  const symbol = symbolSchema.safeParse(req.params.symbol);
  if (!symbol.success) return error(res, 400, "INVALID_REQUEST", "Symbole invalide.");

  try {
    await prisma.watchlistItem.deleteMany({ where: { userId: id, symbol: symbol.data } });
    return res.status(204).end();
  } catch (err) {
    return internal(res, err);
  }
});

export default router;
