import { Router, Request, Response, NextFunction } from "express";
import type { AdminRole, KycStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { generateToken } from "@/lib/jsonwebtoken.js";
import { comparePasswords, hashPassword } from "@/utils/utils.js";
import { AppError } from "@/utils/errorHandler.js";
import { authLimiter } from "@/middlewares/rate.limiter.middlewares.js";
import { ledgerFor, postCashMovement } from "@/modules/ledger/ledger.service.js";
import { BrokerConnectionService } from "@/modules/broker/broker.service.js";
import { recordAudit } from "./admin.audit.js";
import { ROLE_PERMISSIONS, can, requireAdmin } from "./admin.rbac.js";

/**
 * ============================================================
 * BACK-OFFICE — /api/v1/admin
 * ============================================================
 * Toute action qui modifie quelque chose est inscrite au journal d'audit.
 */
const router = Router();
const broker = new BrokerConnectionService();

const ROLES: AdminRole[] = ["SUPER_ADMIN", "ADMIN", "FINANCE", "SUPPORT"];
const KYC: KycStatus[] = ["NOT_STARTED", "PENDING", "VERIFIED", "REJECTED"];

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, _next: NextFunction) =>
  fn(req, res).catch((error: unknown) => {
    if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message });
    console.error(error);
    return res.status(500).json({ success: false, message: "Erreur serveur." });
  });

const audit = (req: Request, action: string, targetId: string | null, details?: Prisma.InputJsonValue) =>
  recordAudit(req, { action, targetId, details });

const param = (req: Request, name: string) => String(req.params[name]);

/** Pagination commune : `?page=` (1 par défaut), `?pageSize=` (25, 100 au plus). */
const paging = (req: Request) => {
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  const take = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize)) || 25));
  return { page, take, skip: (page - 1) * take };
};
const sendPage = (res: Response, p: ReturnType<typeof paging>, data: unknown[], total: number) =>
  res.json({ success: true, data, total, page: p.page, pageSize: p.take });

const balances = async (userId: string) => {
  const [live, paper] = await Promise.all([ledgerFor(userId, "LIVE"), ledgerFor(userId, "PAPER")]);
  const view = (s: typeof live) => ({ cashUsd: s.cashUsd.toFixed(2), availableUsd: s.cashUsd.minus(s.reservedUsd).toFixed(2) });
  return { live: view(live), paper: view(paper) };
};

const CLIENT_FIELDS = {
  user_id: true,
  email: true,
  first_name: true,
  last_name: true,
  phone_number: true,
  country: true,
  is_active: true,
  kyc_status: true,
  trading_mode: true,
  created_at: true
} as const;

// ---------- Session ----------

router.post(
  "/auth/login",
  authLimiter,
  wrap(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") throw new AppError("Email et mot de passe requis.", 400);
    const actorEmail = email.trim().toLowerCase().slice(0, 255);
    const admin = await prisma.adminUser.findUnique({ where: { email: actorEmail } });
    const reason = !admin
      ? "unknown_email"
      : !admin.isActive
        ? "account_disabled"
        : !(await comparePasswords(admin.password, password))
          ? "wrong_password"
          : null;
    if (reason) {
      await recordAudit(req, { action: "admin.login_failed", adminId: admin?.id, actorEmail, details: { reason } });
      throw new AppError("Email ou mot de passe incorrect.", 401);
    }
    await prisma.adminUser.update({ where: { id: admin!.id }, data: { lastLoginAt: new Date() } });
    await recordAudit(req, { action: "admin.login", adminId: admin!.id, actorEmail });
    // `user_id` vide : `requireAuth` (clients) refuse ce jeton.
    const token = await generateToken({ user_id: "", admin_id: admin!.id, scope: "admin" });
    res.json({ success: true, token });
  })
);

router.use(requireAdmin);

// Le jeton reste valide jusqu'à expiration (JWT sans état) : la
// déconnexion côté serveur sert au journal ; l'interface oublie le jeton.
router.post(
  "/auth/logout",
  wrap(async (req, res) => {
    await recordAudit(req, { action: "admin.logout" });
    res.json({ success: true });
  })
);

router.get(
  "/auth/me",
  wrap(async (req, res) => {
    res.json({ success: true, data: { ...req.admin, permissions: ROLE_PERMISSIONS[req.admin!.role] } });
  })
);

// ---------- Clients ----------

router.get(
  "/dashboard",
  can("clients.read"),
  wrap(async (req, res) => {
    const day = new Date(Date.now() - 24 * 3600 * 1000);
    const week = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const clientRow = { user_id: true, email: true, first_name: true, last_name: true, kyc_status: true, created_at: true } as const;
    const canAudit = ROLE_PERMISSIONS[req.admin!.role].includes("audit.read");

    const [
      total,
      active,
      kycPending,
      newThisWeek,
      liveCredits,
      ordersToday,
      ordersFailedToday,
      recentClients,
      pendingKyc,
      recentMovements,
      recentOrders,
      failedLogins
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { is_active: true } }),
      prisma.user.count({ where: { kyc_status: "PENDING" } }),
      prisma.user.count({ where: { created_at: { gte: week } } }),
      prisma.cashMovement.aggregate({ where: { environment: "LIVE" }, _sum: { amountUsd: true } }),
      prisma.order.count({ where: { createdAt: { gte: day } } }),
      prisma.order.count({ where: { createdAt: { gte: day }, status: { in: ["FAILED", "REJECTED"] } } }),
      prisma.user.findMany({ select: clientRow, orderBy: { id: "desc" }, take: 5 }),
      prisma.user.findMany({ where: { kyc_status: "PENDING" }, select: clientRow, orderBy: { id: "asc" }, take: 5 }),
      prisma.cashMovement.findMany({
        where: { createdBy: { not: "system" } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          environment: true,
          amount: true,
          currency: true,
          amountUsd: true,
          createdAt: true,
          user: { select: { user_id: true, email: true, first_name: true, last_name: true } }
        }
      }),
      prisma.order.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          side: true,
          status: true,
          requestedAmount: true,
          requestedCurrency: true,
          createdAt: true,
          asset: { select: { symbol: true } },
          brokerConnection: { select: { environment: true } },
          user: { select: { user_id: true, email: true, first_name: true, last_name: true } }
        }
      }),
      canAudit
        ? prisma.adminAuditLog.findMany({
            where: { action: { endsWith: "login_failed" } },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, action: true, actorEmail: true, ip: true, createdAt: true }
          })
        : Promise.resolve(null)
    ]);

    res.json({
      success: true,
      data: {
        stats: {
          total,
          active,
          kycPending,
          newThisWeek,
          liveDepositsUsd: (liveCredits._sum.amountUsd ?? 0).toString(),
          ordersToday,
          ordersFailedToday
        },
        recentClients,
        pendingKyc,
        recentMovements,
        recentOrders,
        failedLogins
      }
    });
  })
);

router.get(
  "/clients",
  can("clients.read"),
  wrap(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const p = paging(req);
    const where: Prisma.userWhereInput = q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { first_name: { contains: q, mode: "insensitive" } },
            { last_name: { contains: q, mode: "insensitive" } },
            { phone_number: { contains: q } }
          ]
        }
      : {};
    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, select: CLIENT_FIELDS, orderBy: { id: "desc" }, skip: p.skip, take: p.take })
    ]);
    // ponytail: 2 lectures du ledger par ligne (une page), agrégat SQL si la liste ralentit.
    const data = await Promise.all(rows.map(async (u) => ({ ...u, balances: await balances(u.user_id!) })));
    sendPage(res, p, data, total);
  })
);

router.get(
  "/clients/:id",
  can("clients.read"),
  wrap(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { user_id: param(req, "id") }, select: CLIENT_FIELDS });
    if (!user) throw new AppError("Client introuvable.", 404);
    const userId = user.user_id!;
    const [live, paper] = await Promise.all([
      ledgerFor(userId, "LIVE"),
      ledgerFor(userId, "PAPER")
    ]);

    const held = [...live.holdings, ...paper.holdings].filter(([, h]) => h.quantity.gt(0));
    // Cours facultatifs : sans eux, la fiche s'affiche quand même (prix de revient seul).
    const quotes = await broker.quotes([...new Set(held.map(([s]) => s))]).catch(() => []);
    const price = new Map(quotes.map((q) => [q.symbol, q.price]));
    const positions = (environment: "LIVE" | "PAPER", state: typeof live) =>
      [...state.holdings]
        .filter(([, h]) => h.quantity.gt(0))
        .map(([symbol, h]) => {
          const current = price.get(symbol);
          const value = current ? h.quantity.times(current) : null;
          return {
            environment,
            symbol,
            quantity: h.quantity.toFixed(),
            averagePrice: h.cost.div(h.quantity).toFixed(4),
            costUsd: h.cost.toFixed(2),
            currentPrice: current ?? null,
            marketValueUsd: value?.toFixed(2) ?? null,
            unrealizedPlUsd: value?.minus(h.cost).toFixed(2) ?? null,
            unrealizedPlPercent: value && h.cost.gt(0) ? value.minus(h.cost).div(h.cost).times(100).toFixed(2) : null
          };
        });

    const view = (s: typeof live) => ({ cashUsd: s.cashUsd.toFixed(2), availableUsd: s.cashUsd.minus(s.reservedUsd).toFixed(2) });
    res.json({
      success: true,
      data: {
        ...user,
        balances: { live: view(live), paper: view(paper) },
        positions: [...positions("LIVE", live), ...positions("PAPER", paper)]
      }
    });
  })
);

router.get(
  "/clients/:id/orders",
  can("clients.read"),
  wrap(async (req, res) => {
    const p = paging(req);
    const where = { userId: param(req, "id") };
    const [total, data] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.take,
        select: {
          id: true,
          side: true,
          status: true,
          requestedAmount: true,
          requestedCurrency: true,
          notional: true,
          quantity: true,
          filledQuantity: true,
          averageFilledPrice: true,
          fee: true,
          failureMessage: true,
          createdAt: true,
          filledAt: true,
          asset: { select: { symbol: true, name: true } },
          brokerConnection: { select: { environment: true } }
        }
      })
    ]);
    sendPage(res, p, data, total);
  })
);

router.get(
  "/clients/:id/movements",
  can("clients.read"),
  wrap(async (req, res) => {
    const p = paging(req);
    const where = { userId: param(req, "id") };
    const [total, data] = await Promise.all([
      prisma.cashMovement.count({ where }),
      prisma.cashMovement.findMany({ where, orderBy: { createdAt: "desc" }, skip: p.skip, take: p.take })
    ]);
    sendPage(res, p, data, total);
  })
);

router.patch(
  "/clients/:id",
  can("clients.write"),
  wrap(async (req, res) => {
    const { is_active, kyc_status } = req.body ?? {};
    const data: Prisma.userUpdateInput = {};
    if (typeof is_active === "boolean") data.is_active = is_active;
    if (kyc_status !== undefined) {
      if (!KYC.includes(kyc_status)) throw new AppError("Statut KYC inconnu.", 400);
      data.kyc_status = kyc_status;
    }
    if (!Object.keys(data).length) throw new AppError("Rien à modifier.", 400);
    const user = await prisma.user.update({ where: { user_id: param(req, "id") }, data, select: CLIENT_FIELDS }).catch(() => {
      throw new AppError("Client introuvable.", 404);
    });
    await audit(req, "client.update", user.user_id, data as Prisma.InputJsonValue);
    res.json({ success: true, data: user });
  })
);

router.post(
  "/clients/:id/movements",
  can("funds.write"),
  wrap(async (req, res) => {
    const { amount, currency, note, environment } = req.body ?? {};
    if (environment !== "LIVE" && environment !== "PAPER") throw new AppError("Mode attendu : LIVE ou PAPER.", 400);
    const user = await prisma.user.findUnique({ where: { user_id: param(req, "id") }, select: { user_id: true } });
    if (!user) throw new AppError("Client introuvable.", 404);
    const movement = await postCashMovement({
      userId: user.user_id!,
      environment,
      amount: String(amount ?? ""),
      currency,
      note: String(note ?? ""),
      createdBy: `admin:${req.admin!.email}`
    });
    await audit(req, "client.funds", user.user_id, {
      movementId: movement.id,
      environment,
      amount: movement.amount.toString(),
      currency,
      amountUsd: movement.amountUsd.toString()
    });
    res.status(201).json({ success: true, data: movement });
  })
);

// ---------- Équipe (admins) ----------

const ADMIN_FIELDS = { id: true, email: true, name: true, role: true, isActive: true, lastLoginAt: true, createdAt: true } as const;

router.get(
  "/admins",
  can("admins.manage"),
  wrap(async (req, res) => {
    const p = paging(req);
    const [total, data] = await Promise.all([
      prisma.adminUser.count(),
      prisma.adminUser.findMany({ select: ADMIN_FIELDS, orderBy: { createdAt: "asc" }, skip: p.skip, take: p.take })
    ]);
    sendPage(res, p, data, total);
  })
);

router.post(
  "/admins",
  can("admins.manage"),
  wrap(async (req, res) => {
    const { email, name, password, role } = req.body ?? {};
    if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) throw new AppError("Email invalide.", 400);
    if (typeof name !== "string" || !name.trim()) throw new AppError("Nom requis.", 400);
    if (typeof password !== "string" || password.length < 12) throw new AppError("Mot de passe : 12 caractères minimum.", 400);
    if (!ROLES.includes(role)) throw new AppError("Rôle inconnu.", 400);
    const admin = await prisma.adminUser
      .create({
        data: { email: email.trim().toLowerCase(), name: name.trim(), password: await hashPassword(password), role },
        select: ADMIN_FIELDS
      })
      .catch(() => {
        throw new AppError("Un administrateur existe déjà avec cet email.", 409);
      });
    await audit(req, "admin.create", admin.id, { email: admin.email, role });
    res.status(201).json({ success: true, data: admin });
  })
);

router.patch(
  "/admins/:id",
  can("admins.manage"),
  wrap(async (req, res) => {
    const id = param(req, "id");
    const { role, isActive, password } = req.body ?? {};
    // Garde-fou : on ne se retire pas soi-même l'accès.
    if (id === req.admin!.id && (role !== undefined || isActive === false)) {
      throw new AppError("Vous ne pouvez pas modifier votre propre rôle ni vous désactiver.", 400);
    }
    const data: Prisma.AdminUserUpdateInput = {};
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw new AppError("Rôle inconnu.", 400);
      data.role = role;
    }
    if (typeof isActive === "boolean") data.isActive = isActive;
    if (password !== undefined) {
      if (typeof password !== "string" || password.length < 12) throw new AppError("Mot de passe : 12 caractères minimum.", 400);
      data.password = await hashPassword(password);
    }
    if (!Object.keys(data).length) throw new AppError("Rien à modifier.", 400);
    const admin = await prisma.adminUser.update({ where: { id }, data, select: ADMIN_FIELDS }).catch(() => {
      throw new AppError("Administrateur introuvable.", 404);
    });
    await audit(req, "admin.update", id, { role, isActive, passwordReset: password !== undefined });
    res.json({ success: true, data: admin });
  })
);

// ---------- Journal ----------

router.get(
  "/audit",
  can("audit.read"),
  wrap(async (req, res) => {
    // Préfixe d'action : « admin.login », « client. »…
    const action = String(req.query.action ?? "").trim();
    const q = String(req.query.q ?? "").trim();
    const p = paging(req);
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(action ? { action: { startsWith: action } } : {}),
      ...(q ? { OR: [{ actorEmail: { contains: q, mode: "insensitive" } }, { ip: { contains: q } }] } : {})
    };
    const [total, data] = await Promise.all([
      prisma.adminAuditLog.count({ where }),
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.take,
        include: { admin: { select: { email: true, name: true } } }
      })
    ]);
    sendPage(res, p, data, total);
  })
);

export default router;
