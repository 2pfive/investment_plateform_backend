import { Request, Response } from "express";
import { z } from "zod";
import { BrokerError } from "@/ports/broker.errors.js";
import { OrderService } from "./order.service.js";

/** Corps commun à l'estimation et au passage d'ordre. */
const orderBody = z.object({
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9.]{0,9}$/, "symbole invalide"),
  side: z.enum(["BUY", "SELL"]),
  /** Chaîne décimale positive. Jamais un `number` : pas d'arrondi binaire. */
  amount: z.string().regex(/^\d{1,12}(\.\d{1,8})?$/, "montant invalide"),
  currency: z.enum(["XAF", "EUR", "USD"]),
  environment: z.string().max(8).optional()
});

const listQuery = z.object({
  environment: z.string().max(8).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().uuid().optional()
});

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_:-]{8,128}$/);

export class OrderController {
  constructor(private readonly service = new OrderService()) {
    this.estimate = this.estimate.bind(this);
    this.place = this.place.bind(this);
    this.list = this.list.bind(this);
    this.get = this.get.bind(this);
  }

  private userId(req: Request): string | null {
    const id = req.user?.user_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  private invalid(res: Response, message: string) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_REQUEST", message }
    });
  }

  private fail(res: Response, error: unknown, operation: string) {
    if (error instanceof BrokerError) {
      return res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message }
      });
    }

    console.error(`[orders] ${operation} :`, (error as Error)?.name || "erreur");
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Une erreur inattendue est survenue. Réessayez dans un instant."
      }
    });
  }

  /** POST /orders/estimate — sans effet, ni ordre ni clé. */
  async estimate(req: Request, res: Response) {
    const userId = this.userId(req);
    if (!userId) return res.status(401).end();

    const body = orderBody.safeParse(req.body);
    if (!body.success) return this.invalid(res, "Ordre invalide : symbole, sens, montant ou devise.");

    try {
      const data = await this.service.estimate(userId, body.data);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return this.fail(res, error, "estimation");
    }
  }

  /**
   * POST /orders — exige l'en-tête `Idempotency-Key`.
   *
   * 201 : transmis (et peut-être déjà exécuté).
   * 202 : issue inconnue, confirmation du courtier en attente.
   * 422 : refusé par le courtier ; l'ordre est tout de même tracé.
   */
  async place(req: Request, res: Response) {
    const userId = this.userId(req);
    if (!userId) return res.status(401).end();

    const key = idempotencyKey.safeParse(req.header("Idempotency-Key"));
    if (!key.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message: "En-tête Idempotency-Key manquant ou invalide (8 à 128 caractères)."
        }
      });
    }

    const body = orderBody.safeParse(req.body);
    if (!body.success) return this.invalid(res, "Ordre invalide : symbole, sens, montant ou devise.");

    try {
      const outcome = await this.service.placeOrder(userId, body.data, key.data);

      if (outcome.replayed) res.setHeader("Idempotent-Replayed", "true");

      const payload =
        outcome.status === 422 ? outcome.body : { success: true, data: outcome.body };
      return res.status(outcome.status).json(payload);
    } catch (error) {
      return this.fail(res, error, "passage d'ordre");
    }
  }

  /** GET /orders?environment=&limit=&cursor= */
  async list(req: Request, res: Response) {
    const userId = this.userId(req);
    if (!userId) return res.status(401).end();

    const query = listQuery.safeParse(req.query);
    if (!query.success) return this.invalid(res, "Paramètres de liste invalides.");

    try {
      const data = await this.service.listOrders(userId, query.data);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return this.fail(res, error, "liste des ordres");
    }
  }

  /** GET /orders/:id */
  async get(req: Request, res: Response) {
    const userId = this.userId(req);
    if (!userId) return res.status(401).end();

    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return this.invalid(res, "Identifiant d’ordre invalide.");

    try {
      res.setHeader("Cache-Control", "no-store");
      const data = await this.service.getOrder(userId, id.data);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return this.fail(res, error, "lecture d'un ordre");
    }
  }
}
