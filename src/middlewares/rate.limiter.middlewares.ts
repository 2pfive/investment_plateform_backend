import rateLimit from "express-rate-limit";

/**
 * Limitation de débit.
 *
 * `express-rate-limit` était installé depuis le début mais ce fichier était
 * vide : aucune route n'était protégée. `/auth/login` acceptait donc un
 * nombre illimité de tentatives.
 *
 * Note : le compteur vit en mémoire du processus. Cela suffit pour un
 * déploiement mono-instance ; dès qu'il y aura plusieurs instances derrière un
 * load balancer, il faudra un store partagé (Redis), sinon la limite effective
 * est multipliée par le nombre d'instances.
 */

const jsonError = (code: string, message: string) => ({
  success: false,
  error: { code, message }
});

/**
 * Authentification : strict. Vise le credential stuffing et le brute force.
 * `skipSuccessfulRequests` fait qu'une connexion réussie ne consomme pas de
 * quota — un utilisateur légitime n'est jamais bloqué par ses propres succès.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: jsonError(
    "TOO_MANY_ATTEMPTS",
    "Trop de tentatives de connexion. Réessayez dans quelques minutes."
  )
});

/**
 * Création de compte : encore plus strict, par adresse IP.
 */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: jsonError(
    "TOO_MANY_ATTEMPTS",
    "Trop de créations de compte depuis cette adresse. Réessayez plus tard."
  )
});

/**
 * Opérations financières : borne les rejeux d'ordres.
 * Ne remplace PAS l'idempotence, qui reste la vraie protection contre la
 * double soumission — cette limite ne fait qu'endiguer l'abus.
 */
export const tradingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: jsonError(
    "TOO_MANY_REQUESTS",
    "Trop d'opérations en peu de temps. Patientez un instant."
  )
});

/**
 * Garde-fou général sur l'API, large par construction : il ne doit jamais
 * gêner un usage normal, seulement plafonner les abus.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: jsonError(
    "TOO_MANY_REQUESTS",
    "Trop de requêtes. Réessayez plus tard."
  )
});
