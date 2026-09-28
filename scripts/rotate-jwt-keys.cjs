/**
 * Rotation de la paire de clés RSA de signature JWT.
 *
 * L'ancienne paire est compromise : elle est versionnée dans git, donc connue
 * de quiconque a accès au dépôt. La rotation est la seule remédiation réelle —
 * réécrire l'historique ne « dé-divulgue » pas une clé.
 *
 * Ce script :
 *   1. génère une nouvelle paire RSA 4096 ;
 *   2. chiffre la clé privée avec une passphrase aléatoire de 48 octets ;
 *   3. écrit les clés dans secrets/ (ignoré par git) ;
 *   4. écrit la passphrase dans .env.development (déjà ignoré par git).
 *
 * La passphrase n'est JAMAIS affichée sur la sortie standard.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2];
const SECRETS = path.join(ROOT, "secrets");
const ENV_FILE = path.join(ROOT, ".env.development");

if (!fs.existsSync(SECRETS)) fs.mkdirSync(SECRETS, { recursive: true });

const privPath = path.join(SECRETS, "jwt_private.pem");
const pubPath = path.join(SECRETS, "jwt_public.pem");

if (fs.existsSync(privPath)) {
  console.log("ABANDON : secrets/jwt_private.pem existe deja. Rien n'a ete ecrase.");
  process.exit(1);
}

const passphrase = crypto.randomBytes(48).toString("base64");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 4096,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase,
  },
});

fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });

// Verification : la paire signe et verifie correctement
const key = crypto.createPrivateKey({ key: privateKey, format: "pem", passphrase });
const sig = crypto.sign("sha256", Buffer.from("amara"), key);
const ok = crypto.verify("sha256", Buffer.from("amara"), publicKey, sig);
if (!ok) {
  console.log("ECHEC : la paire generee ne verifie pas. Fichiers supprimes.");
  fs.unlinkSync(privPath);
  fs.unlinkSync(pubPath);
  process.exit(1);
}

// Mise a jour de .env.development (gitignore, verifie non suivi par git)
let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
const line = `JWT_PRIVATE_KEY_PASSPHRASE=${passphrase}`;

if (/^JWT_PRIVATE_KEY_PASSPHRASE=.*$/m.test(env)) {
  env = env.replace(/^JWT_PRIVATE_KEY_PASSPHRASE=.*$/m, line);
} else {
  if (env.length && !env.endsWith("\n")) env += "\n";
  env += "\n# Rotation du 2026-08-31 — passphrase de la cle privee JWT (secrets/jwt_private.pem)\n";
  env += line + "\n";
}

if (!/^JWT_PRIVATE_KEY_PATH=/m.test(env)) {
  env += "JWT_PRIVATE_KEY_PATH=./secrets/jwt_private.pem\n";
}
if (!/^JWT_PUBLIC_KEY_PATH=/m.test(env)) {
  env += "JWT_PUBLIC_KEY_PATH=./secrets/jwt_public.pem\n";
}

fs.writeFileSync(ENV_FILE, env);

console.log("Nouvelle paire RSA 4096 generee et verifiee.");
console.log("  secrets/jwt_private.pem  (chiffree AES-256-CBC, mode 600)");
console.log("  secrets/jwt_public.pem");
console.log("Passphrase ecrite dans .env.development, non affichee ici.");
console.log("Empreinte de la cle publique (SHA-256) :");
console.log("  " + crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32));
