import { AppError } from "@/utils/errorHandler.js";

/**
 * Codes d'erreur du courtier, tels que le mobile les reçoit.
 *
 * Le message accompagnant chaque code est affiché tel quel à l'utilisateur :
 * il doit être en français, compréhensible, et ne rien révéler de l'interne.
 */
export type BrokerErrorCode =
  /** Variables Alpaca absentes ou invalides : problème d'exploitation. */
  | "BROKER_NOT_CONFIGURED"
  | "BROKER_ENVIRONMENT_NOT_ALLOWED"
  | "INVALID_RETURN_URL"
  | "INVALID_REQUEST"
  | "BROKER_NOT_CONNECTED"
  /** Le courtier refuse le jeton : révoqué, ou périmètre insuffisant. */
  | "BROKER_UNAUTHORIZED"
  | "BROKER_RATE_LIMITED"
  /** Courtier injoignable, lent, ou en erreur serveur. */
  | "BROKER_UNAVAILABLE"
  /** Toute autre réponse inattendue du courtier. */
  | "BROKER_REQUEST_FAILED"
  /* --- Ordres --- */
  /** Le courtier a refusé l'ordre : fonds, position, actif. L'ordre est tracé. */
  | "ORDER_REJECTED"
  | "ORDER_NOT_FOUND"
  | "INVALID_AMOUNT"
  | "ASSET_NOT_FOUND"
  | "ASSET_NOT_TRADABLE"
  | "ASSET_NOT_FRACTIONABLE"
  /** Pas de taux de change fiable : l'ordre n'est pas émis sur un taux inventé. */
  | "FX_UNAVAILABLE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  /** Même clé, contenu différent : refusé, jamais rejoué. */
  | "IDEMPOTENCY_CONFLICT"
  /** Même clé, requête d'origine encore en cours. */
  | "IDEMPOTENCY_IN_PROGRESS";

export class BrokerError extends AppError {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode, message: string, statusCode: number) {
    super(message, statusCode);
    this.code = code;
    this.name = "BrokerError";
  }
}
