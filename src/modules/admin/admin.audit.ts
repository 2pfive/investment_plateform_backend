import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

/**
 * Inscrit un évènement au journal, avec l'IP (`trust proxy` actif : c'est
 * celle du client, pas du load balancer) et le navigateur.
 *
 * Ne lève jamais : un journal en panne ne doit pas bloquer une connexion.
 */
export async function recordAudit(
  req: Request,
  event: { action: string; adminId?: string | null; actorEmail?: string | null; targetId?: string | null; details?: Prisma.InputJsonValue }
) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        action: event.action,
        adminId: event.adminId ?? req.admin?.id ?? null,
        actorEmail: event.actorEmail ?? req.admin?.email ?? null,
        targetId: event.targetId ?? null,
        details: event.details,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent")?.slice(0, 512) ?? null
      }
    });
  } catch (error) {
    console.error("[audit] écriture impossible", (error as Error).message);
  }
}
