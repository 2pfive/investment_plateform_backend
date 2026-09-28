import crypto from "crypto";

/**
 * ============================================================
 * CHIFFREMENT DES JETONS DE COURTIER
 * ============================================================
 *
 * AES-256-GCM. Chaque jeton est chiffré avec un IV aléatoire de 12 octets ;
 * la sortie assemble `iv.tag.ciphertext`, chacun en base64url.
 *
 * Deux protections au-delà du chiffrement lui-même :
 *
 * 1. **Donnée associée (AAD).** Le chiffré est lié à son propriétaire —
 *    utilisateur, fournisseur, environnement. Un chiffré recopié d'une ligne
 *    à une autre en base ne se déchiffre plus : sans cela, quiconque peut
 *    écrire dans la table pourrait greffer le jeton de quelqu'un sur son
 *    propre compte AMARA.
 *
 * 2. **Identifiant de clé.** Stocké à côté du chiffré, il permet de faire
 *    tourner la clé sans casser les connexions existantes.
 *
 * Alpaca ne délivre ni date d'expiration ni jeton de rafraîchissement : un
 * jeton volé reste valable jusqu'à révocation. D'où le chiffrement au repos
 * obligatoire, et l'interdiction absolue de journaliser un jeton — en clair,
 * chiffré ou tronqué.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface TokenKeyRing {
  activeId: string;
  byId: Map<string, Buffer>;
}

export interface EncryptedToken {
  ciphertext: string;
  keyId: string;
}

/** Contexte lié au chiffré. Toute différence au déchiffrement le rend illisible. */
export interface TokenBinding {
  userId: string;
  provider: string;
  environment: string;
}

function aad(binding: TokenBinding): Buffer {
  return Buffer.from(
    `amara:broker-token:v1:${binding.userId}:${binding.provider}:${binding.environment}`,
    "utf8"
  );
}

export function encryptToken(
  token: string,
  binding: TokenBinding,
  keys: TokenKeyRing
): EncryptedToken {
  const key = keys.byId.get(keys.activeId);
  if (!key) {
    throw new Error("Clé de chiffrement active introuvable");
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES
  });
  cipher.setAAD(aad(binding));

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: [iv, tag, encrypted]
      .map((part) => part.toString("base64url"))
      .join("."),
    keyId: keys.activeId
  };
}

/**
 * Déchiffre un jeton.
 *
 * Lève une erreur générique en cas d'échec, sans distinguer « clé inconnue »,
 * « chiffré altéré » et « mauvais propriétaire » : le détail n'aide que
 * celui qui tâtonne.
 */
export function decryptToken(
  encrypted: EncryptedToken,
  binding: TokenBinding,
  keys: TokenKeyRing
): string {
  const failure = () => new Error("Jeton de courtier indéchiffrable");

  const key = keys.byId.get(encrypted.keyId);
  if (!key) throw failure();

  const parts = encrypted.ciphertext.split(".");
  if (parts.length !== 3) throw failure();

  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw failure();

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES
    });
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8"
    );
  } catch {
    throw failure();
  }
}

/**
 * Empreinte SHA-256 d'un jeton, en hexadécimal.
 *
 * Sert à reconnaître un même jeton sans le stocker ni le journaliser : le
 * jeton est une valeur aléatoire à forte entropie, son empreinte ne permet
 * pas de le retrouver.
 */
export function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Le chiffré a-t-il été produit avec une clé qui n'est plus l'active ? */
export function needsReencryption(
  encrypted: EncryptedToken,
  keys: TokenKeyRing
): boolean {
  return encrypted.keyId !== keys.activeId;
}
