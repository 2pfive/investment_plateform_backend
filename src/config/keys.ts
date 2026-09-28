import crypto from "crypto";
import { readFileSync } from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({
  path: `.env.${process.env.NODE_ENV || "development"}`
});

/**
 * Chargement des clés de signature JWT.
 *
 * L'ancienne implémentation lisait `./src/config/session_user_key_*.pem`, deux
 * fichiers versionnés dans git — donc connus de quiconque a accès au dépôt.
 * Ces clés sont considérées comme définitivement compromises et ont été
 * remplacées le 2026-08-31.
 *
 * Le chemin est désormais configurable, les clés vivent hors du contrôle de
 * version, et le chargement se fait UNE SEULE FOIS au démarrage : une clé
 * manquante fait échouer le boot plutôt que la première requête authentifiée.
 */

const PRIVATE_KEY_PATH =
  process.env.JWT_PRIVATE_KEY_PATH || "./secrets/jwt_private.pem";

const PUBLIC_KEY_PATH =
  process.env.JWT_PUBLIC_KEY_PATH || "./secrets/jwt_public.pem";

/** Signature RSA uniquement. Verrouillé pour interdire la confusion d'algorithme. */
export const JWT_ALGORITHM = "RS256" as const;

/** Durée de vie d'un token. Une DURÉE, pas un horodatage. */
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";

function resolve(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function read(p: string, label: string): Buffer {
  const full = resolve(p);
  try {
    return readFileSync(full);
  } catch {
    throw new Error(
      `Clé ${label} introuvable : ${full}\n` +
        `Générer la paire avec « npm run keys:rotate », ou pointer ` +
        `JWT_${label.toUpperCase()}_KEY_PATH vers un fichier existant.`
    );
  }
}

let privateKey: crypto.KeyObject;

try {
  privateKey = crypto.createPrivateKey({
    key: read(PRIVATE_KEY_PATH, "private"),
    format: "pem",
    // Absente pour une clé non chiffrée : Node l'accepte comme undefined.
    passphrase: process.env.JWT_PRIVATE_KEY_PASSPHRASE
  });
} catch (err: any) {
  throw new Error(
    `Impossible de charger la clé privée JWT. ` +
      `Vérifier JWT_PRIVATE_KEY_PASSPHRASE dans .env.${process.env.NODE_ENV || "development"}. ` +
      `Cause : ${err?.message}`
  );
}

const publicKey = crypto.createPublicKey(read(PUBLIC_KEY_PATH, "public"));

export const JWT_PRIVATE_KEY = privateKey;
export const JWT_PUBLIC_KEY = publicKey;
