import { Request, Response, NextFunction } from "express";
import { config } from "@/config/env.js";
import { verifyToken } from "@/lib/jsonwebtoken.js";

/**
 * Garde d'authentification.
 *
 * Correctifs du 2026-08-31 :
 *   * la vérification passe par `verifyToken`, qui verrouille `algorithms`
 *     sur RS256 — sans quoi la confusion d'algorithme RS256 → HS256 était
 *     exploitable, la clé publique étant versionnée dans git ;
 *   * le token complet n'est plus journalisé : c'était une crédentielle de
 *     session écrite en clair dans les logs, à chaque requête ;
 *   * la clé publique est chargée une fois au démarrage (`config/keys.ts`),
 *     plus à chaque import via un `readFileSync` au chemin relatif.
 */
export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let token: string | undefined = req.cookies?.[`${config.cookie_jwt_name}`];

  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentification requise."
      }
    });
  }

  try {
    const decoded = verifyToken(token);

    if (!decoded?.payload?.user_id) {
      throw new Error("payload sans user_id");
    }

    req.user = decoded.payload;
    return next();
  } catch (err: any) {
    // Le nom de l'erreur suffit au diagnostic ; le token n'est jamais tracé.
    console.warn("Rejet JWT :", err?.name || "erreur de vérification");

    return res.status(401).json({
      success: false,
      error: {
        code: "INVALID_TOKEN",
        message: "Session invalide ou expirée."
      }
    });
  }
};
