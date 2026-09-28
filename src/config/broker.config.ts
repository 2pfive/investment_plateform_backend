import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({
  path: `.env.${process.env.NODE_ENV || "development"}`
});

/**
 * ============================================================
 * CONFIGURATION DU COURTIER — Alpaca OAuth
 * ============================================================
 *
 * Chargée à la demande, et NON au démarrage.
 *
 * Le frontend web est en service sur ce même backend et ne dépend pas du
 * courtier. Une variable Alpaca manquante ne doit donc pas empêcher le
 * serveur de démarrer : seules les routes `/broker/*` répondent alors
 * `BROKER_NOT_CONFIGURED`. Les clés JWT, elles, restent vérifiées au boot
 * (`config/keys.ts`) — sans elles, plus personne ne se connecte.
 *
 * Aucune valeur de ce fichier n'est journalisée : il transporte le
 * `client_secret` et la clé de chiffrement des jetons.
 */

const ENVIRONMENTS = ["PAPER", "LIVE"] as const;
export type BrokerEnvironmentName = (typeof ENVIRONMENTS)[number];

const isProduction = process.env.NODE_ENV === "production";

/** Liste séparée par des virgules, espaces tolérés, entrées vides ignorées. */
const csv = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

/**
 * URL absolue. En production, HTTPS obligatoire : le code d'autorisation et
 * le jeton transitent par ces adresses.
 */
const secureUrl = z
  .string()
  .url()
  .refine((value) => !isProduction || value.startsWith("https://"), {
    message: "HTTPS obligatoire en production"
  });

/** Clé AES-256 : exactement 32 octets, encodés en base64. */
const aesKey = z
  .string()
  .refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "doit encoder exactement 32 octets en base64"
  });

/** Identifiant de clé : court, sans séparateur — il est stocké en base. */
const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, {
  message: "1 à 32 caractères parmi A-Z a-z 0-9 _ -"
});

const schema = z.object({
  ALPACA_OAUTH_CLIENT_ID: z.string().min(1),
  ALPACA_OAUTH_CLIENT_SECRET: z.string().min(1),

  /**
   * Adresse de rappel, déclarée à l'identique dans l'application Alpaca
   * Connect. Pointe vers CE backend (`…/api/v1/broker/alpaca/callback`),
   * jamais vers l'application mobile.
   */
  ALPACA_OAUTH_REDIRECT_URI: secureUrl,

  /**
   * Périmètres demandés, séparés par des espaces. `trading` seul : la lecture
   * est accordée par défaut, `account:write` modifierait la configuration du
   * compte, `data` n'est utile que si l'on abandonne Yahoo Finance.
   */
  ALPACA_OAUTH_SCOPES: z.string().default("trading"),

  /*
   * Adresses d'Alpaca. Surchargeables pour pointer vers un faux serveur en
   * test d'intégration ; les valeurs par défaut sont celles de la
   * documentation officielle.
   */
  ALPACA_OAUTH_AUTHORIZE_URL: secureUrl.default(
    "https://app.alpaca.markets/oauth/authorize"
  ),
  ALPACA_OAUTH_TOKEN_URL: secureUrl.default(
    "https://api.alpaca.markets/oauth/token"
  ),
  ALPACA_API_URL_PAPER: secureUrl.default("https://paper-api.alpaca.markets"),
  ALPACA_API_URL_LIVE: secureUrl.default("https://api.alpaca.markets"),

  /** Environnement utilisé quand la requête n'en précise pas. */
  BROKER_DEFAULT_ENVIRONMENT: z.enum(ENVIRONMENTS).default("PAPER"),

  /**
   * Environnements ouverts. Les deux par défaut : chaque utilisateur peut
   * relier un compte paper ET un compte réel. Restreindre ici est une
   * décision d'exploitation, pas une limite du code.
   */
  BROKER_ALLOWED_ENVIRONMENTS: csv
    .pipe(z.array(z.enum(ENVIRONMENTS)).min(1))
    .default(["PAPER", "LIVE"]),

  /** Clé de chiffrement active des jetons, et son identifiant. */
  BROKER_TOKEN_KEY_ID: keyId,
  BROKER_TOKEN_KEY: aesKey,

  /**
   * Anciennes clés, encore capables de DÉCHIFFRER : `id:base64,id:base64`.
   * Permet une rotation sans invalider les connexions existantes — les jetons
   * sont rechiffrés avec la clé active à leur prochaine utilisation.
   */
  BROKER_TOKEN_PREVIOUS_KEYS: z.string().default(""),

  /**
   * Destinations autorisées pour le retour vers l'application, séparées par
   * des virgules. Deux formes :
   *
   *   - `amara:`                      tout lien du schéma `amara://`
   *   - `exp://192.168.1.10:8081`     schéma + hôte + port, exactement
   *
   * La comparaison se fait sur l'URL analysée, jamais par préfixe de chaîne :
   * `http://localhost:8081` par préfixe accepterait
   * `http://localhost:8081.attaquant.com`.
   */
  MOBILE_RETURN_URL_ALLOWLIST: csv.pipe(z.array(z.string()).min(1)),

  /** Durée de validité d'un `state`, en secondes. */
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600)
});

export interface BrokerConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: Record<BrokerEnvironmentName, string>;
  defaultEnvironment: BrokerEnvironmentName;
  allowedEnvironments: BrokerEnvironmentName[];
  tokenKeys: {
    activeId: string;
    /** Toutes les clés capables de déchiffrer, active comprise. */
    byId: Map<string, Buffer>;
  };
  returnUrlAllowlist: string[];
  stateTtlSeconds: number;
}

export type BrokerConfigResult =
  | { ok: true; config: BrokerConfig }
  /** `problems` nomme les variables fautives, jamais leurs valeurs. */
  | { ok: false; problems: string[] };

function parsePreviousKeys(raw: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();

  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator);
    const material = entry.slice(separator + 1);

    if (separator <= 0 || !keyId.safeParse(id).success) {
      throw new Error("BROKER_TOKEN_PREVIOUS_KEYS : identifiant invalide");
    }
    if (!aesKey.safeParse(material).success) {
      throw new Error(`BROKER_TOKEN_PREVIOUS_KEYS : clé « ${id} » invalide`);
    }

    keys.set(id, Buffer.from(material, "base64"));
  }

  return keys;
}

function load(): BrokerConfigResult {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")} : ${issue.message}`
      )
    };
  }

  const env = parsed.data;

  let byId: Map<string, Buffer>;
  try {
    byId = parsePreviousKeys(env.BROKER_TOKEN_PREVIOUS_KEYS);
  } catch (error) {
    return { ok: false, problems: [(error as Error).message] };
  }

  // La clé active prime sur une ancienne clé portant le même identifiant.
  byId.set(env.BROKER_TOKEN_KEY_ID, Buffer.from(env.BROKER_TOKEN_KEY, "base64"));

  if (!env.BROKER_ALLOWED_ENVIRONMENTS.includes(env.BROKER_DEFAULT_ENVIRONMENT)) {
    return {
      ok: false,
      problems: [
        "BROKER_DEFAULT_ENVIRONMENT : doit figurer dans BROKER_ALLOWED_ENVIRONMENTS"
      ]
    };
  }

  return {
    ok: true,
    config: {
      clientId: env.ALPACA_OAUTH_CLIENT_ID,
      clientSecret: env.ALPACA_OAUTH_CLIENT_SECRET,
      redirectUri: env.ALPACA_OAUTH_REDIRECT_URI,
      scopes: env.ALPACA_OAUTH_SCOPES,
      authorizeUrl: env.ALPACA_OAUTH_AUTHORIZE_URL,
      tokenUrl: env.ALPACA_OAUTH_TOKEN_URL,
      apiUrl: {
        PAPER: env.ALPACA_API_URL_PAPER.replace(/\/+$/, ""),
        LIVE: env.ALPACA_API_URL_LIVE.replace(/\/+$/, "")
      },
      defaultEnvironment: env.BROKER_DEFAULT_ENVIRONMENT,
      allowedEnvironments: env.BROKER_ALLOWED_ENVIRONMENTS,
      tokenKeys: { activeId: env.BROKER_TOKEN_KEY_ID, byId },
      returnUrlAllowlist: env.MOBILE_RETURN_URL_ALLOWLIST,
      stateTtlSeconds: env.OAUTH_STATE_TTL_SECONDS
    }
  };
}

let cached: BrokerConfigResult | null = null;

/** Configuration du courtier, analysée une seule fois par processus. */
export function brokerConfig(): BrokerConfigResult {
  if (!cached) cached = load();
  return cached;
}

/** Réservé aux tests : force une nouvelle lecture de `process.env`. */
export function resetBrokerConfigForTests(): void {
  cached = null;
}
