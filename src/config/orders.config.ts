import dotenv from "dotenv";
import Decimal from "decimal.js";
import { z } from "zod";

dotenv.config({
  path: `.env.${process.env.NODE_ENV || "development"}`
});

/**
 * ============================================================
 * CONFIGURATION DES ORDRES
 * ============================================================
 *
 * Toutes les valeurs ont un défaut sûr : ce fichier ne bloque jamais le
 * démarrage. Une valeur invalide est signalée et remplacée par son défaut,
 * plutôt que de rendre l'API inutilisable.
 */

const decimalString = (min: string, max: string) =>
  z.string().refine(
    (value) => {
      try {
        const d = new Decimal(value);
        return d.isFinite() && d.gte(min) && d.lte(max);
      } catch {
        return false;
      }
    },
    { message: `décimal attendu entre ${min} et ${max}` }
  );

const schema = z.object({
  /**
   * Frais AMARA, en proportion du montant saisi. **0 par défaut.**
   *
   * Par OAuth, AMARA ne peut prélever aucun frais : il n'existe pas de
   * périmètre de virement. Un taux non nul ne ferait que réduire le montant
   * investi — l'argent resterait sur le compte de l'utilisateur, jamais chez
   * AMARA. Paramètre conservé pour un futur modèle (Broker API, abonnement).
   */
  ORDER_FEE_RATE: decimalString("0", "0.1").default("0"),

  /** Plancher du courtier pour un ordre en montant : « as little as $1 ». */
  ORDER_MIN_NOTIONAL_USD: decimalString("1", "1000000").default("1"),

  /**
   * Plafond par ordre, en dollars. Vide : pas de plafond. Garde-fou
   * d'exploitation contre une faute de frappe, pas une règle métier.
   */
  ORDER_MAX_NOTIONAL_USD: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .pipe(decimalString("1", "100000000").nullable()),

  /** Au-delà, un taux stocké est rafraîchi avant usage. */
  FX_REFRESH_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),

  /**
   * Au-delà, un taux stocké n'est plus utilisable, même en secours : l'ordre
   * est refusé plutôt qu'émis sur un taux périmé.
   */
  FX_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(172_800).default(3600),

  /** Synchronisation des ordres non terminés auprès du courtier. */
  ORDER_SYNC_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  ORDER_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(3600).default(15)
});

export type OrdersConfig = {
  feeRate: string;
  minNotionalUsd: string;
  maxNotionalUsd: string | null;
  fxRefreshSeconds: number;
  fxMaxAgeSeconds: number;
  syncEnabled: boolean;
  syncIntervalSeconds: number;
};

let cached: OrdersConfig | null = null;

export function ordersConfig(): OrdersConfig {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  const env = parsed.success ? parsed.data : schema.parse({});

  if (!parsed.success) {
    console.warn(
      "[orders] configuration invalide, valeurs par défaut utilisées :",
      parsed.error.issues.map((i) => i.path.join(".")).join(", ")
    );
  }

  cached = {
    feeRate: env.ORDER_FEE_RATE,
    minNotionalUsd: env.ORDER_MIN_NOTIONAL_USD,
    maxNotionalUsd: env.ORDER_MAX_NOTIONAL_USD,
    fxRefreshSeconds: env.FX_REFRESH_SECONDS,
    fxMaxAgeSeconds: env.FX_MAX_AGE_SECONDS,
    syncEnabled: env.ORDER_SYNC_ENABLED,
    syncIntervalSeconds: env.ORDER_SYNC_INTERVAL_SECONDS
  };

  return cached;
}
