import { prisma as defaultPrisma } from "@/lib/prisma.js";

/**
 * ============================================================
 * NOTIFICATIONS PUSH — service Expo Push
 * ============================================================
 *
 * Les appareils enregistrent leur jeton Expo (`ExponentPushToken[…]`) après
 * connexion ; le backend l'utilise pour les prévenir d'un événement sur leur
 * compte, comme un ordre exécuté.
 *
 * Envoi par l'API HTTP d'Expo, qui relaie vers APNs et FCM : aucune clé
 * Apple ou Google ici. `EXPO_ACCESS_TOKEN` n'est requis que si la sécurité
 * renforcée des envois est activée sur le projet Expo.
 *
 * Un envoi ne fait JAMAIS échouer l'opération qui le déclenche : une
 * notification perdue est un inconfort, un ordre marqué en erreur à cause
 * d'elle serait un mensonge.
 *
 * ponytail: seuls les tickets d'envoi sont lus (jeton désinscrit → supprimé).
 * Les reçus de livraison (`/getReceipts`) ne sont pas relevés ; à ajouter si
 * l'on veut détecter les identifiants FCM/APNs révoqués après coup.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;
const TIMEOUT_MS = 10_000;

export interface PushMessage {
  title: string;
  body: string;
  /** Lu par l'application au toucher de la notification. */
  data?: Record<string, string>;
}

interface ExpoTicket {
  status: "ok" | "error";
  details?: { error?: string };
}

export function isExpoPushToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export class PushService {
  private readonly prisma: typeof defaultPrisma;

  constructor(deps: { prisma?: typeof defaultPrisma } = {}) {
    this.prisma = deps.prisma ?? defaultPrisma;
  }

  /** Rattache l'appareil au compte. Idempotent ; réattribue s'il changeait de compte. */
  async register(userId: string, token: string, platform: string): Promise<void> {
    await this.prisma.pushToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform }
    });
  }

  /** Détache l'appareil, à la déconnexion. Seul son propriétaire le peut. */
  async unregister(userId: string, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { userId, token } });
  }

  /** Envoie à tous les appareils du compte. Ne lève jamais. */
  async sendToUser(userId: string, message: PushMessage): Promise<void> {
    try {
      const devices = await this.prisma.pushToken.findMany({
        where: { userId },
        select: { token: true }
      });
      if (devices.length === 0) return;

      const tokens = devices.map((d) => d.token);
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(process.env.EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
            : {})
        },
        // Un utilisateur a quelques appareils : bien en deçà des 100 messages
        // qu'Expo accepte par requête.
        body: JSON.stringify(
          tokens.map((to) => ({ to, sound: "default", priority: "high", ...message }))
        ),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });

      if (!response.ok) {
        console.warn(`[push] envoi refusé par Expo : HTTP ${response.status}`);
        return;
      }

      // Les tickets reviennent dans l'ordre des messages.
      const { data } = (await response.json()) as { data?: ExpoTicket[] };
      const gone = tokens.filter(
        (_, i) => data?.[i]?.status === "error" && data[i].details?.error === "DeviceNotRegistered"
      );
      if (gone.length > 0) {
        await this.prisma.pushToken.deleteMany({ where: { token: { in: gone } } });
      }
    } catch (error) {
      console.warn("[push] envoi impossible :", (error as Error)?.name || "erreur");
    }
  }
}
