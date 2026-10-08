import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { isExpoPushToken, PushService } from "./push.service.js";

/**
 * Appareils inscrits aux notifications push. Monté sous `requireAuth`.
 *
 *   POST   /notifications/push-tokens          { token, platform }
 *   DELETE /notifications/push-tokens/:token
 */

const tokenSchema = z.string().max(255).refine(isExpoPushToken, "jeton Expo invalide");
const body = z.object({
  token: tokenSchema,
  platform: z.enum(["ios", "android"])
});

const router = Router();
const push = new PushService();

function userId(req: Request): string | null {
  const id = req.user?.user_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function invalid(res: Response) {
  return res.status(400).json({
    success: false,
    error: { code: "INVALID_REQUEST", message: "Jeton de notification invalide." }
  });
}

function internal(res: Response, error: unknown) {
  console.error("[notifications]", (error as Error)?.name || "erreur");
  return res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Une erreur inattendue est survenue." }
  });
}

router.post("/push-tokens", async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).end();
  const parsed = body.safeParse(req.body);
  if (!parsed.success) return invalid(res);

  try {
    await push.register(id, parsed.data.token, parsed.data.platform);
    return res.status(204).end();
  } catch (error) {
    return internal(res, error);
  }
});

router.delete("/push-tokens/:token", async (req, res) => {
  const id = userId(req);
  if (!id) return res.status(401).end();
  const parsed = tokenSchema.safeParse(req.params.token);
  if (!parsed.success) return invalid(res);

  try {
    await push.unregister(id, parsed.data);
    return res.status(204).end();
  } catch (error) {
    return internal(res, error);
  }
});

export default router;
