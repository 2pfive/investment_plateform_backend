import axios, { AxiosError } from "axios";
import { BrokerError } from "@/ports/broker.errors.js";

/**
 * Délai maximal d'un appel à Alpaca.
 *
 * Un appel sans plafond immobilise la requête du mobile, qui abandonne de
 * son côté au bout de quinze secondes : mieux vaut échouer d'abord ici, avec
 * un code exploitable, que laisser le client deviner.
 */
export const ALPACA_TIMEOUT_MS = 10_000;

export const alpacaHttp = axios.create({
  timeout: ALPACA_TIMEOUT_MS,
  headers: { Accept: "application/json" }
});

/**
 * Motif de refus renvoyé par Alpaca, tronqué.
 *
 * Alpaca répond `{ code, message }`. Le message décrit la règle enfreinte
 * (« insufficient buying power ») : utile au diagnostic et à la traduction,
 * et sans donnée secrète — contrairement aux en-têtes.
 */
export function alpacaReason(error: unknown): string | null {
  const data = (error as AxiosError<{ message?: unknown }>)?.response?.data;
  const message = data && typeof data === "object" ? data.message : null;
  return typeof message === "string" ? message.slice(0, 200) : null;
}

interface MappingOptions {
  /**
   * Sens d'un 403 pour cet appel.
   *
   * Sur une LECTURE, 403 signifie que le jeton n'a pas (ou plus) le droit :
   * la connexion doit passer en révoquée. Sur un PASSAGE D'ORDRE, Alpaca
   * répond aussi 403 pour un pouvoir d'achat insuffisant — traiter ce cas
   * comme une révocation déconnecterait l'utilisateur pour un simple manque
   * de fonds.
   */
  forbidden?: "unauthorized" | "rejected";
}

/**
 * Traduit un échec d'appel à Alpaca en `BrokerError`.
 *
 * Seuls le statut HTTP et le code d'erreur réseau sont journalisés. Jamais
 * l'URL complète (elle peut porter un code d'autorisation), jamais les
 * en-têtes (ils portent le jeton), jamais le corps (il peut refléter la
 * requête).
 */
export function toBrokerError(
  error: unknown,
  operation: string,
  options: MappingOptions = {}
): BrokerError {
  if (error instanceof BrokerError) return error;

  const axiosError = error as AxiosError;
  const status = axiosError?.response?.status;
  const forbidden = options.forbidden ?? "unauthorized";

  console.warn(
    `[alpaca] ${operation} en échec :`,
    status ? `HTTP ${status}` : axiosError?.code || "erreur inconnue"
  );

  if (!status) {
    return new BrokerError(
      "BROKER_UNAVAILABLE",
      "Alpaca ne répond pas pour le moment. Réessayez dans un instant.",
      503
    );
  }

  if (status === 401 || (status === 403 && forbidden === "unauthorized")) {
    return new BrokerError(
      "BROKER_UNAUTHORIZED",
      "Alpaca refuse l’accès. L’autorisation a peut-être été révoquée : reconnectez votre compte.",
      409
    );
  }

  if (status === 429) {
    return new BrokerError(
      "BROKER_RATE_LIMITED",
      "Trop de requêtes vers Alpaca. Patientez un instant.",
      503
    );
  }

  if (status >= 500) {
    return new BrokerError(
      "BROKER_UNAVAILABLE",
      "Alpaca rencontre un incident. Réessayez dans un instant.",
      503
    );
  }

  if (forbidden === "rejected" && (status === 403 || status === 422 || status === 400)) {
    return new BrokerError("ORDER_REJECTED", rejectionMessage(alpacaReason(error)), 422);
  }

  return new BrokerError(
    "BROKER_REQUEST_FAILED",
    "La demande auprès d’Alpaca n’a pas abouti.",
    502
  );
}

/**
 * Motif de refus en français.
 *
 * Les messages d'Alpaca ne sont pas un contrat documenté : on reconnaît les
 * cas fréquents par mots-clés, et on retombe sur un message générique
 * plutôt que d'afficher de l'anglais à l'utilisateur.
 */
export function rejectionMessage(reason: string | null): string {
  const text = (reason ?? "").toLowerCase();

  if (text.includes("buying power") || text.includes("insufficient")) {
    return "Pouvoir d’achat insuffisant sur votre compte Alpaca pour cet ordre.";
  }
  if (text.includes("fractionable")) {
    return "Cet actif ne peut pas être acheté par fraction.";
  }
  if (text.includes("position") || text.includes("qty") || text.includes("shares")) {
    return "Vous ne détenez pas assez de titres pour cette vente.";
  }
  if (text.includes("not tradable") || text.includes("tradable")) {
    return "Cet actif n’est pas négociable pour le moment.";
  }
  if (text.includes("client_order_id")) {
    return "Cet ordre a déjà été transmis.";
  }

  return "Alpaca a refusé l’ordre.";
}
