import jwt from "jsonwebtoken";
import {
  JWT_ALGORITHM,
  JWT_EXPIRES_IN,
  JWT_PRIVATE_KEY,
  JWT_PUBLIC_KEY
} from "@/config/keys.js";

export interface SessionPayload {
  user_id: string;
  account_id?: string;
  portfolio_id?: string;
  /** Aligne le type sur la déclaration `Express.Request["user"]`. */
  [key: string]: unknown;
}

/**
 * Signe un token de session.
 *
 * Correctif du 2026-08-31 : `expiresIn` recevait
 * `Math.floor(Date.now() / 1000) + 86400`, c'est-à-dire ~1,79 milliard.
 * Or `expiresIn` attend une DURÉE en secondes, pas un horodatage : les tokens
 * émis étaient valides environ 55 ans. Ils expirent désormais en 24 h.
 *
 * Plus aucun log ici : la passphrase et le contenu de la clé privée étaient
 * affichés en clair à chaque signature.
 */
export const generateToken = async (
  payload: SessionPayload
): Promise<string> => {
  return jwt.sign({ payload }, JWT_PRIVATE_KEY, {
    algorithm: JWT_ALGORITHM,
    expiresIn: JWT_EXPIRES_IN
  } as jwt.SignOptions);
};

/**
 * Vérifie un token.
 *
 * `algorithms` est explicitement verrouillé sur RS256. Sans cette contrainte,
 * un attaquant connaissant la clé publique peut présenter un token signé en
 * HS256 avec cette même clé publique comme secret HMAC, et la bibliothèque
 * l'accepte. C'était directement exploitable ici : la clé publique était
 * versionnée dans git.
 */
export const verifyToken = (token: string): { payload: SessionPayload } => {
  return jwt.verify(token, JWT_PUBLIC_KEY, {
    algorithms: [JWT_ALGORITHM]
  }) as { payload: SessionPayload };
};
