import dotenv from "dotenv";

dotenv.config({
  path: `.env.${process.env.NODE_ENV || "development"}`
});

const isProduction = process.env.NODE_ENV === "production";

const origins =
  process.env.ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) || ["http://localhost:5173"];

/**
 * CORS.
 *
 * Correctif du 2026-08-31 : l'ancienne implémentation acceptait
 * inconditionnellement toute origine commençant par `http://localhost:` ou
 * `http://127.0.0.1:`, y compris en production. N'importe quelle page servie
 * en local pouvait donc appeler l'API de production avec les cookies de
 * session de l'utilisateur.
 *
 * La tolérance localhost est désormais réservée au développement.
 */
const corsOptions = {
  origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Requêtes sans origine : outils en ligne de commande, applications
    // mobiles natives, appels serveur à serveur.
    if (!origin) return callback(null, true);

    if (origins.includes(origin)) return callback(null, true);

    if (
      !isProduction &&
      (origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:"))
    ) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  exposedHeaders: ["Content-Range", "X-Total-Count"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
  maxAge: 600
};

/**
 * Le port lisait `process.env.PORT` alors que `.env.development` définit
 * `SERVER_PORT` : la valeur configurée n'était jamais prise en compte et le
 * serveur retombait systématiquement sur 3300. Les deux noms sont désormais
 * acceptés, et la valeur est convertie en `number`.
 */
const port = Number(process.env.SERVER_PORT || process.env.PORT || 3300);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(
    `Port invalide : « ${process.env.SERVER_PORT || process.env.PORT} ». ` +
      `Attendu un entier entre 1 et 65535.`
  );
}

export const config = {
  isProduction,
  origins,
  corsOptions,
  port,
  saltRounds: Number(process.env.SALT_ROUNDS) || 10,
  cookie_jwt_name: process.env.COOKIE_JWT_NAME || "AUTH_TOKEN",
  exchange_rate_url: `${process.env.EXCHANGE_RATE_URL}${process.env.EXCHANGE_RATE_API_KEY}`
};
