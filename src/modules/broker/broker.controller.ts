import { Request, Response } from "express";
import { z } from "zod";
import { BrokerError } from "@/ports/broker.errors.js";
import { BrokerConnectionService } from "./broker.service.js";

const authorizeBody = z.object({
  returnUrl: z.string().min(1).max(512),
  environment: z.string().max(8).optional()
});

const environmentQuery = z.object({
  environment: z.string().max(8).optional()
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Page affichée dans le navigateur quand on ne sait pas où renvoyer
 * l'utilisateur. Volontairement minimale et sans ressource externe.
 */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000B11;color:#fff;font-family:system-ui,sans-serif}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:rgba(255,255,255,.72);line-height:1.5}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

export class BrokerController {
  constructor(private readonly service = new BrokerConnectionService()) {
    this.authorize = this.authorize.bind(this);
    this.callback = this.callback.bind(this);
    this.getConnection = this.getConnection.bind(this);
    this.disconnect = this.disconnect.bind(this);
  }

  /** Réponse d'erreur au format commun de l'API. */
  private fail(res: Response, error: unknown, operation: string) {
    if (error instanceof BrokerError) {
      return res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message }
      });
    }

    console.error(`[broker] ${operation} :`, (error as Error)?.name || "erreur");
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Une erreur inattendue est survenue. Réessayez dans un instant."
      }
    });
  }

  private userId(req: Request): string | null {
    const id = req.user?.user_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  private unauthenticated(res: Response) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Authentification requise." }
    });
  }

  /** POST /broker/alpaca/authorize */
  async authorize(req: Request, res: Response) {
    const userId = this.userId(req);
    if (!userId) return this.unauthenticated(res);

    const parsed = authorizeBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "Adresse de retour manquante ou invalide." }
      });
    }

    try {
      const data = await this.service.startAuthorization(userId, parsed.data);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      return this.fail(res, error, "ouverture d'autorisation");
    }
  }

  /**
   * GET /broker/alpaca/callback — public.
   *
   * Appelé par le navigateur, redirigé par Alpaca. Aucune donnée de compte ni
   * aucun jeton ne repart vers l'application : seulement `result`, qui dit au
   * mobile d'arrêter d'attendre. L'état réel se relit ensuite, authentifié.
   */
  async callback(req: Request, res: Response) {
    // Le code d'autorisation transite dans l'URL : ni cache, ni référent.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");

    try {
      const outcome = await this.service.completeAuthorization({
        code: req.query.code,
        state: req.query.state,
        error: req.query.error
      });

      if (outcome.kind === "redirect") {
        return res.redirect(302, outcome.location);
      }

      return res
        .status(outcome.status)
        .type("html")
        .send(page(outcome.title, outcome.body));
    } catch (error) {
      console.error("[broker] rappel OAuth :", (error as Error)?.name || "erreur");
      return res
        .status(500)
        .type("html")
        .send(
          page(
            "Connexion interrompue",
            "Une erreur est survenue. Revenez dans l’application AMARA et relancez la connexion."
          )
        );
    }
  }

  /** GET /broker/connection?environment=PAPER|LIVE */
  async getConnection(req: Request, res: Response) {
    const userId = this.userId(req);
    if (!userId) return this.unauthenticated(res);

    const query = environmentQuery.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "Environnement invalide." }
      });
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      const data = await this.service.getConnection(userId, query.data.environment);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return this.fail(res, error, "lecture de la connexion");
    }
  }

  /** DELETE /broker/connection?environment=PAPER|LIVE */
  async disconnect(req: Request, res: Response) {
    const userId = this.userId(req);
    if (!userId) return this.unauthenticated(res);

    const query = environmentQuery.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_REQUEST", message: "Environnement invalide." }
      });
    }

    try {
      await this.service.disconnect(userId, query.data.environment);
      return res.status(204).end();
    } catch (error) {
      return this.fail(res, error, "déconnexion");
    }
  }
}
