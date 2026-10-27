import { Request, Response, NextFunction } from "express";
import type { AdminRole } from "@prisma/client";
import { verifyToken } from "@/lib/jsonwebtoken.js";
import { prisma } from "@/lib/prisma.js";
import { recordAudit } from "./admin.audit.js";

/**
 * ============================================================
 * RBAC du back-office
 * ============================================================
 *
 * Un rôle = une liste de permissions, ici et nulle part ailleurs. L'interface
 * lit la même liste via `/admin/auth/me` pour masquer ce qui est interdit ;
 * le serveur reste seul juge.
 */
export const PERMISSIONS = [
  "clients.read",
  "clients.write", // activer / désactiver, statut KYC
  "funds.write", // créditer / débiter un solde
  "admins.manage",
  "audit.read"
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  ADMIN: ["clients.read", "clients.write", "funds.write", "audit.read"],
  FINANCE: ["clients.read", "funds.write", "audit.read"],
  SUPPORT: ["clients.read", "clients.write"]
};

export interface AdminSession {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminSession;
    }
  }
}

const deny = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

/**
 * Jeton admin en `Authorization: Bearer` uniquement (pas de cookie : aucun
 * risque CSRF). Le compte est relu à chaque requête : une désactivation ou un
 * changement de rôle prend effet immédiatement.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return deny(res, 401, "UNAUTHENTICATED", "Authentification requise.");

  let adminId: unknown;
  try {
    const { payload } = verifyToken(header.slice(7).trim());
    // Un jeton client (scope absent) n'ouvre jamais le back-office.
    if (payload.scope !== "admin") throw new Error("scope");
    adminId = payload.admin_id;
  } catch {
    return deny(res, 401, "INVALID_TOKEN", "Session invalide ou expirée.");
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id: String(adminId) },
    select: { id: true, email: true, name: true, role: true, isActive: true }
  });
  if (!admin?.isActive) return deny(res, 401, "INVALID_TOKEN", "Session invalide ou expirée.");

  req.admin = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
  return next();
}

export const can = (permission: Permission) => async (req: Request, res: Response, next: NextFunction) => {
  if (req.admin && ROLE_PERMISSIONS[req.admin.role].includes(permission)) return next();
  // Une tentative hors de son rôle est un signal : on la garde.
  await recordAudit(req, { action: "admin.forbidden", details: { permission, method: req.method, path: req.originalUrl } });
  return deny(res, 403, "FORBIDDEN", "Action non autorisée pour votre rôle.");
};
