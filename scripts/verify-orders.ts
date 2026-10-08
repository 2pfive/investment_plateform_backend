/**
 * ============================================================
 * VÉRIFICATION DE BOUT EN BOUT — ordres en argent réel
 * ============================================================
 *
 * Faux serveur Alpaca et faux fournisseur de taux en local, vrai backend
 * branché dessus, worker de synchronisation actif. Rejoue :
 *
 *   estimation, passage, rejeu idempotent, conflit de clé, double envoi
 *   simultané, exécution par synchronisation (GET et worker), actif non
 *   fractionnable ou suspendu, refus pour pouvoir d'achat (sans révoquer la
 *   connexion), coupure réseau avec ordre parti puis retrouvé, coupure avec
 *   ordre perdu, statut inconnu en réconciliation, montant trop faible,
 *   taux indisponible, accès à l'ordre d'un autre utilisateur, pagination.
 *
 *   npx tsx scripts/verify-orders.ts
 *
 * Nettoie tout ce qu'il a créé, et restaure les fiches d'actifs existantes
 * qu'il a mises à jour. Refuse de tourner si les utilisateurs de test ont
 * déjà des ordres ou une connexion.
 */
import crypto from "crypto";
import http from "http";
import { spawn, type ChildProcess } from "child_process";

const FAKE_PORT = 4798;
const BACKEND_PORT = 3397;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const API = `http://127.0.0.1:${BACKEND_PORT}/api/v1`;
const TOKEN = `fake-token-${crypto.randomBytes(8).toString("hex")}`;
const RETURN_URL = "http://localhost:8081/connect/alpaca";
const XAF_PER_USD = 605.5;

const env: Record<string, string> = {
  ALPACA_OAUTH_CLIENT_ID: "test-client",
  ALPACA_OAUTH_CLIENT_SECRET: "test-secret",
  ALPACA_OAUTH_REDIRECT_URI: `http://127.0.0.1:${BACKEND_PORT}/api/v1/broker/alpaca/callback`,
  ALPACA_OAUTH_AUTHORIZE_URL: `${FAKE}/oauth/authorize`,
  ALPACA_OAUTH_TOKEN_URL: `${FAKE}/oauth/token`,
  ALPACA_API_URL_PAPER: FAKE,
  ALPACA_API_URL_LIVE: FAKE,
  BROKER_TOKEN_KEY_ID: "test-key",
  BROKER_TOKEN_KEY: crypto.randomBytes(32).toString("base64"),
  BROKER_DEFAULT_ENVIRONMENT: "PAPER",
  BROKER_ALLOWED_ENVIRONMENTS: "PAPER,LIVE",
  MOBILE_RETURN_URL_ALLOWLIST: "http://localhost:8081",
  EXCHANGE_RATE_URL: `${FAKE}/fx/`,
  EXCHANGE_RATE_API_KEY: "test-fx-key",
  ORDER_FEE_RATE: "0",
  // Indépendant du plafond et du compte partagé de .env.development.
  ORDER_MAX_NOTIONAL_USD: "",
  ALPACA_KEY: "",
  ALPACA_SECRET: "",
  ALPACA_KEY_ENVIRONMENT: "",
  ALPACA_PAPER_KEY: "",
  ALPACA_LIVE_KEY: "",
  ALPACA_TRADING_MODE: "",
  ORDER_SYNC_ENABLED: "true",
  ORDER_SYNC_INTERVAL_SECONDS: "2"
};
Object.assign(process.env, env);

/* ---------------------------------------------------------------- */

let failures = 0;
let passed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ================================================================
 * FAUX ALPACA
 * ================================================================ */

type FakeOrder = Record<string, unknown> & { id: string; client_order_id: string; status: string; reads: number };
const fakeOrders = new Map<string, FakeOrder>();
const posted: Array<Record<string, unknown>> = [];
let fxDown = false;

const ASSETS: Record<string, { tradable: boolean; fractionable: boolean; status?: string }> = {
  SPY: { tradable: true, fractionable: true },
  VTI: { tradable: true, fractionable: true },
  POOR: { tradable: true, fractionable: true },
  FLAKY: { tradable: true, fractionable: true },
  LOST: { tradable: true, fractionable: true },
  WEIRD: { tradable: true, fractionable: true },
  NOFRAC: { tradable: true, fractionable: false },
  HALT: { tradable: false, fractionable: true }
};

function orderJson(o: FakeOrder) {
  const { reads, ...rest } = o;
  void reads;
  return rest;
}

const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", FAKE);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const authorized = req.headers.authorization === `Bearer ${TOKEN}`;

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    // --- taux de change ---
    if (url.pathname === "/fx/test-fx-key/latest/USD") {
      if (fxDown) return send(500, { result: "error" });
      return send(200, { result: "success", conversion_rates: { USD: 1, XAF: XAF_PER_USD, EUR: 0.92 } });
    }

    // --- OAuth ---
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const form = new URLSearchParams(raw);
      if (form.get("code") !== "good-code") return send(401, { message: "invalid_grant" });
      return send(200, { access_token: TOKEN, token_type: "bearer", scope: "trading" });
    }

    if (!authorized) return send(401, { message: "unauthorized" });

    if (url.pathname === "/v2/account") {
      return send(200, {
        id: "acc-orders", account_number: "PA9ORDERS001", status: "ACTIVE", currency: "USD",
        cash: "500.00", buying_power: "500.00", trading_blocked: false, account_blocked: false,
        trade_suspended_by_user: false
      });
    }

    if (url.pathname === "/v2/clock") {
      return send(200, {
        timestamp: new Date().toISOString(), is_open: true,
        next_open: "2026-09-16T13:30:00Z", next_close: "2026-09-15T20:00:00Z"
      });
    }

    const asset = /^\/v2\/assets\/(.+)$/.exec(url.pathname);
    if (asset) {
      const symbol = decodeURIComponent(asset[1]);
      const spec = ASSETS[symbol];
      if (!spec) return send(404, { message: "asset not found" });
      return send(200, {
        id: `asset-${symbol}`, symbol, name: `${symbol} Test Asset`, exchange: "ARCA",
        status: spec.status ?? "active", tradable: spec.tradable, fractionable: spec.fractionable,
        shortable: false
      });
    }

    if (req.method === "POST" && url.pathname === "/v2/orders") {
      const body = JSON.parse(raw);
      posted.push(body);
      const symbol = body.symbol as string;

      if (symbol === "POOR") return send(403, { code: 40310000, message: "insufficient buying power" });

      const order: FakeOrder = {
        id: crypto.randomUUID(), client_order_id: body.client_order_id, symbol,
        side: body.side, status: symbol === "WEIRD" ? "quantum_state" : "accepted",
        notional: body.notional, qty: null, filled_qty: "0", filled_avg_price: null,
        submitted_at: new Date().toISOString(), filled_at: null, canceled_at: null,
        expired_at: null, failed_at: null, updated_at: new Date().toISOString(), reads: 0
      };

      if (symbol === "LOST") return send(503, { message: "service unavailable" });
      fakeOrders.set(order.id, order);
      if (symbol === "FLAKY") return send(503, { message: "service unavailable" });
      return send(200, orderJson(order));
    }

    const byId = /^\/v2\/orders\/([0-9a-f-]{36})$/.exec(url.pathname);
    const byClient = url.pathname === "/v2/orders:by_client_order_id";
    if (req.method === "GET" && (byId || byClient)) {
      const order = byId
        ? fakeOrders.get(byId[1])
        : [...fakeOrders.values()].find((o) => o.client_order_id === url.searchParams.get("client_order_id"));
      if (!order) return send(404, { message: "order not found" });

      order.reads += 1;
      // Les ordres ordinaires s'exécutent à la première relecture.
      if (order.status === "accepted" && order.reads >= 1) {
        const price = "553.48";
        order.status = "filled";
        order.filled_avg_price = price;
        order.filled_qty = (Number(order.notional) / Number(price)).toFixed(9);
        order.filled_at = new Date().toISOString();
        order.updated_at = new Date().toISOString();
      }
      return send(200, orderJson(order));
    }

    send(404, { message: "not found" });
  });
});

/* ================================================================ */

function startBackend() {
  const logs: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, SERVER_PORT: String(BACKEND_PORT), NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (d) => logs.push(String(d)));
  child.stderr?.on("data", (d) => logs.push(String(d)));
  return { child, logs };
}

async function waitFor(url: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* pas prêt */ }
    await sleep(500);
  }
  throw new Error(`Délai dépassé : ${url}`);
}

async function main() {
  const { prisma } = await import("../src/lib/prisma.js");
  const { generateToken } = await import("../src/lib/jsonwebtoken.js");

  const users = await prisma.user.findMany({
    select: { user_id: true }, orderBy: { created_at: "asc" }, take: 2
  });
  const [alice, bob] = users.map((u) => u.user_id);

  const conflicts =
    (await prisma.order.count({ where: { userId: { in: [alice, bob] } } })) +
    (await prisma.brokerConnection.count({ where: { userId: { in: [alice, bob] } } }));
  if (conflicts > 0) throw new Error("Utilisateurs de test déjà porteurs d'ordres ou de connexion : annulé.");

  const startedAt = new Date();
  const symbols = Object.keys(ASSETS);
  const preexisting = await prisma.asset.findMany({
    where: { symbol: { in: symbols } },
    select: { symbol: true, exchange: true, tradable: true, fractionable: true, shortable: true, brokerAssetId: true, status: true }
  });
  const preexistingSymbols = new Set(preexisting.map((a) => a.symbol));

  const aliceJwt = await generateToken({ user_id: alice });
  const bobJwt = await generateToken({ user_id: bob });

  const api = async (
    path: string,
    jwt: string,
    init: { method?: string; body?: unknown; key?: string } = {}
  ) => {
    const response = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        ...(init.key ? { "Idempotency-Key": init.key } : {})
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: "manual"
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      json: text ? (JSON.parse(text) as any) : null,
      text
    };
  };

  const order = (symbol: string, amount = "25000", extra: object = {}) => ({
    symbol, side: "BUY", amount, currency: "XAF", ...extra
  });
  const key = () => `test-${crypto.randomUUID()}`;
  const postedFor = (clientOrderId: string) => posted.filter((p) => p.client_order_id === clientOrderId).length;

  let backend: { child: ChildProcess; logs: string[] } | null = null;
  const createdOrderIds: string[] = [];

  try {
    await new Promise<void>((r) => fake.listen(FAKE_PORT, "127.0.0.1", () => r()));
    backend = startBackend();
    await waitFor(`http://127.0.0.1:${BACKEND_PORT}/health`);

    /* --- connexion d'Alice par le vrai parcours OAuth --- */
    const opened = await api("/broker/alpaca/authorize", aliceJwt, {
      method: "POST", body: { returnUrl: RETURN_URL }
    });
    const state = new URL(opened.json.data.authorizationUrl).searchParams.get("state");
    const cb = await fetch(`${API}/broker/alpaca/callback?code=good-code&state=${state}`, { redirect: "manual" });
    const connected = (await api("/broker/connection", aliceJwt)).json?.data?.status === "CONNECTED";
    if (cb.status !== 302 || !connected) throw new Error("Connexion OAuth de test impossible.");

    /* ============================================================ */
    console.log("\nEstimation");

    const est = await api("/orders/estimate", aliceJwt, { method: "POST", body: order("SPY") });
    check("200", est.status === 200, est.json);
    check("25 000 FCFA à 605,5 → 41,28 $ (arrondi au cent inférieur)", est.json?.data?.notionalUsd === "41.28", est.json);
    check("taux 605.5 transmis", est.json?.data?.fxRate === "605.5");
    check("frais 0", est.json?.data?.fee === "0");
    check("horloge de marché incluse", est.json?.data?.market?.isOpen === true);
    const fxRows = await prisma.fxRate.count({ where: { quote: "XAF", fetchedAt: { gte: startedAt } } });
    check("taux historisé en base", fxRows >= 1);
    check("aucun ordre créé par l'estimation", (await prisma.order.count({ where: { userId: alice } })) === 0);

    /* ============================================================ */
    console.log("\nPassage et idempotence");

    const noKey = await api("/orders", aliceJwt, { method: "POST", body: order("SPY") });
    check("sans Idempotency-Key : 400", noKey.status === 400 && noKey.json?.error?.code === "IDEMPOTENCY_KEY_REQUIRED");

    const k1 = key();
    const first = await api("/orders", aliceJwt, { method: "POST", body: order("SPY"), key: k1 });
    const firstOrder = first.json?.data?.order;
    check("201", first.status === 201, first.json);
    check("statut ACCEPTED", firstOrder?.status === "ACCEPTED", firstOrder);
    check("41,28 $ transmis", firstOrder?.notionalUsd === "41.28");
    if (firstOrder?.id) createdOrderIds.push(firstOrder.id);

    const sent = posted.at(-1);
    check(
      "ordre transmis : notional, market, day, clé AMARA",
      sent?.notional === "41.28" && sent?.type === "market" && sent?.time_in_force === "day" &&
        String(sent?.client_order_id).startsWith(`amara-${alice.slice(0, 8)}-`),
      sent
    );
    check("clé ≤ 128 caractères", String(sent?.client_order_id).length <= 128);

    const replay = await api("/orders", aliceJwt, { method: "POST", body: order("SPY"), key: k1 });
    check("rejeu : même ordre", replay.json?.data?.order?.id === firstOrder?.id, replay.json);
    check("rejeu signalé (Idempotent-Replayed)", replay.headers.get("idempotent-replayed") === "true");
    check("rejeu : un seul envoi au courtier", postedFor(firstOrder?.clientOrderId) === 1);

    const conflict = await api("/orders", aliceJwt, { method: "POST", body: order("SPY", "30000"), key: k1 });
    check("même clé, autre montant : 422 IDEMPOTENCY_CONFLICT", conflict.status === 422 && conflict.json?.error?.code === "IDEMPOTENCY_CONFLICT", conflict.json);

    const k2 = key();
    const [a, b] = await Promise.all([
      api("/orders", aliceJwt, { method: "POST", body: order("SPY", "12000"), key: k2 }),
      api("/orders", aliceJwt, { method: "POST", body: order("SPY", "12000"), key: k2 })
    ]);
    const k2Record = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId: alice, key: k2 } } });
    const k2Orders = await prisma.order.count({ where: { id: k2Record?.resourceId ?? "00000000-0000-0000-0000-000000000000" } });
    // Tronqué au cent, comme le backend : 12 000 / 605,5 = 19,818… → 19,81.
    const twelveNotional = (Math.floor((12000 / XAF_PER_USD) * 100) / 100).toFixed(2);
    const twelve = posted.filter((p) => p.notional === twelveNotional).length;
    check("double envoi simultané : un seul ordre", k2Orders === 1, [a.status, b.status]);
    check("double envoi simultané : un seul envoi au courtier", twelve === 1, { twelve, statuses: [a.status, b.status] });
    // L'autre requête peut recevoir le rejeu (201), l'état en cours de
    // l'ordre déjà créé (202), ou « patientez » si l'ordre n'existe pas
    // encore (409). Jamais un second ordre.
    check(
      "l'autre requête : rejeu, ordre en cours ou « patientez »",
      ["201,201", "201,202", "201,409"].includes([a.status, b.status].sort().join(",")),
      [a.status, b.status]
    );
    if (k2Record?.resourceId) createdOrderIds.push(k2Record.resourceId);

    /* ============================================================ */
    console.log("\nExécution");

    const read = await api(`/orders/${firstOrder.id}`, aliceJwt);
    const filled = read.json?.data?.order;
    check("GET relit le courtier : FILLED", filled?.status === "FILLED", read.json);
    check(
      "quantité exécutée rapportée par le courtier",
      Number(filled?.filledQuantity) === Number((41.28 / 553.48).toFixed(9)),
      filled
    );
    check("prix moyen 553.48", filled?.averageFilledPrice === "553.48");
    const events = await prisma.orderEvent.findMany({
      where: { orderId: firstOrder.id }, orderBy: { occurredAt: "asc" }, select: { toStatus: true }
    });
    check(
      "historique CREATED → ACCEPTED → FILLED, sans doublon",
      events.map((e) => e.toStatus).join(">") === "CREATED>ACCEPTED>FILLED",
      events
    );

    const vti = await api("/orders", aliceJwt, { method: "POST", body: order("VTI", "20000"), key: key() });
    const vtiId = vti.json?.data?.order?.id;
    if (vtiId) createdOrderIds.push(vtiId);
    let byWorker = "";
    for (let i = 0; i < 20 && byWorker !== "FILLED"; i += 1) {
      await sleep(500);
      byWorker = (await prisma.order.findUnique({ where: { id: vtiId }, select: { status: true } }))?.status ?? "";
    }
    check("le worker exécute sans intervention du mobile", byWorker === "FILLED", byWorker);

    /* ============================================================ */
    console.log("\nRefus avant envoi");

    const beforeRefusals = await prisma.order.count({ where: { userId: alice } });

    const nofrac = await api("/orders", aliceJwt, { method: "POST", body: order("NOFRAC"), key: key() });
    check("non fractionnable : 422 ASSET_NOT_FRACTIONABLE", nofrac.status === 422 && nofrac.json?.error?.code === "ASSET_NOT_FRACTIONABLE", nofrac.json);

    const halt = await api("/orders", aliceJwt, { method: "POST", body: order("HALT"), key: key() });
    check("suspendu : 422 ASSET_NOT_TRADABLE", halt.status === 422 && halt.json?.error?.code === "ASSET_NOT_TRADABLE", halt.json);

    const unknownKey = key();
    const unknown = await api("/orders", aliceJwt, { method: "POST", body: order("ZZZZ"), key: unknownKey });
    check("symbole inconnu : 404 ASSET_NOT_FOUND", unknown.status === 404 && unknown.json?.error?.code === "ASSET_NOT_FOUND", unknown.json);
    check(
      "clé libérée après un refus avant envoi",
      (await prisma.idempotencyKey.count({ where: { userId: alice, key: unknownKey } })) === 0
    );

    const tiny = await api("/orders", aliceJwt, { method: "POST", body: order("SPY", "500"), key: key() });
    check("500 FCFA < 1 $ : 400 INVALID_AMOUNT", tiny.status === 400 && tiny.json?.error?.code === "INVALID_AMOUNT", tiny.json);

    const cents = await api("/orders", aliceJwt, { method: "POST", body: order("SPY", "1000.5"), key: key() });
    check("centimes de franc CFA refusés", cents.status === 400 && cents.json?.error?.code === "INVALID_AMOUNT", cents.json);

    check("aucun ordre créé par ces refus", (await prisma.order.count({ where: { userId: alice } })) === beforeRefusals);

    fxDown = true;
    const noFx = await api("/orders", aliceJwt, { method: "POST", body: order("SPY", "50", { currency: "EUR" }), key: key() });
    check("taux EUR indisponible : 503 FX_UNAVAILABLE, pas de taux inventé", noFx.status === 503 && noFx.json?.error?.code === "FX_UNAVAILABLE", noFx.json);
    const stillXaf = await api("/orders/estimate", aliceJwt, { method: "POST", body: order("SPY") });
    check("taux XAF récent encore utilisable pendant la panne", stillXaf.status === 200, stillXaf.json);
    fxDown = false;

    /* ============================================================ */
    console.log("\nRefus et incidents chez le courtier");

    const poor = await api("/orders", aliceJwt, { method: "POST", body: order("POOR"), key: key() });
    check("pouvoir d'achat insuffisant : 422 ORDER_REJECTED", poor.status === 422 && poor.json?.error?.code === "ORDER_REJECTED", poor.json);
    check("message en français", /Pouvoir d’achat insuffisant/.test(poor.json?.error?.message ?? ""), poor.json);
    check("ordre tracé en REJECTED", poor.json?.order?.status === "REJECTED");
    if (poor.json?.order?.id) createdOrderIds.push(poor.json.order.id);
    const stillConnected = await api("/broker/connection", aliceJwt);
    check("un 403 de refus NE révoque PAS la connexion", stillConnected.json?.data?.status === "CONNECTED", stillConnected.json);

    const flaky = await api("/orders", aliceJwt, { method: "POST", body: order("FLAKY"), key: key() });
    check("coupure, ordre parti : retrouvé par sa clé → 201", flaky.status === 201, flaky.json);
    check("statut réel, pas d'attente fictive", flaky.json?.data?.order?.pendingConfirmation === false);
    if (flaky.json?.data?.order?.id) createdOrderIds.push(flaky.json.data.order.id);

    const lost = await api("/orders", aliceJwt, { method: "POST", body: order("LOST"), key: key() });
    const lostOrder = lost.json?.data?.order;
    check("coupure, ordre introuvable : 202 et non « échec »", lost.status === 202 && lostOrder?.pendingConfirmation === true, lost.json);
    if (lostOrder?.id) createdOrderIds.push(lostOrder.id);
    await prisma.order.update({
      where: { id: lostOrder.id },
      data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) }
    });
    const lostRead = await api(`/orders/${lostOrder.id}`, aliceJwt);
    check(
      "10 min sans trace chez le courtier : FAILED NOT_RECEIVED_BY_BROKER",
      lostRead.json?.data?.order?.status === "FAILED" && lostRead.json?.data?.order?.failureCode === "NOT_RECEIVED_BY_BROKER",
      lostRead.json
    );

    const weird = await api("/orders", aliceJwt, { method: "POST", body: order("WEIRD"), key: key() });
    const weirdOrder = weird.json?.data?.order;
    if (weirdOrder?.id) createdOrderIds.push(weirdOrder.id);
    check("statut inconnu : aucun statut deviné", weirdOrder?.status === "CREATED", weird.json);
    const recon = await prisma.reconciliationLog.count({ where: { entityId: weirdOrder?.id, status: "OPEN" } });
    check("statut inconnu : une réconciliation ouverte", recon === 1, recon);
    await sleep(2500);
    const reconAfter = await prisma.reconciliationLog.count({ where: { entityId: weirdOrder?.id, status: "OPEN" } });
    check("réconciliation sans doublon malgré le worker", reconAfter === 1, reconAfter);

    /* ============================================================ */
    console.log("\nLecture");

    const other = await api(`/orders/${firstOrder.id}`, bobJwt);
    check("ordre d'un autre utilisateur : 404", other.status === 404, other.json);

    const page1 = await api("/orders?limit=2", aliceJwt);
    const page2 = await api(`/orders?limit=2&cursor=${page1.json?.data?.nextCursor}`, aliceJwt);
    const ids = [...(page1.json?.data?.orders ?? []), ...(page2.json?.data?.orders ?? [])].map((o: any) => o.id);
    check("pagination : 2 + 2 ordres distincts", ids.length === 4 && new Set(ids).size === 4, { page1: page1.json?.data?.nextCursor, n: ids.length });
    check("montants en chaînes", typeof page1.json?.data?.orders?.[0]?.requestedAmount === "string");

    /* ============================================================ */
    console.log("\nFuites");

    const logs = backend.logs.join("");
    check("aucun jeton dans les journaux", !logs.includes(TOKEN));
    check("aucune clé du fournisseur de taux dans les journaux", !logs.includes("test-fx-key"));
  } finally {
    const ids = [
      ...new Set([
        ...createdOrderIds,
        ...(await prisma.order.findMany({ where: { userId: { in: [alice, bob] } }, select: { id: true } })).map((o) => o.id)
      ])
    ];
    await prisma.reconciliationLog.deleteMany({ where: { entityId: { in: ids } } });
    await prisma.order.deleteMany({ where: { id: { in: ids } } });
    await prisma.idempotencyKey.deleteMany({ where: { userId: { in: [alice, bob] } } });
    await prisma.oAuthState.deleteMany({ where: { userId: { in: [alice, bob] } } });
    await prisma.brokerConnection.deleteMany({ where: { userId: { in: [alice, bob] } } });
    await prisma.fxRate.deleteMany({ where: { fetchedAt: { gte: startedAt } } });
    await prisma.asset.deleteMany({ where: { symbol: { in: symbols.filter((s) => !preexistingSymbols.has(s)) } } });
    for (const asset of preexisting) {
      const { symbol, ...fields } = asset;
      await prisma.asset.update({ where: { symbol }, data: fields });
    }
    if (backend && !backend.child.killed) backend.child.kill();
    fake.close();
    if (failures > 0 && backend) {
      console.log("\n--- journaux du backend (fin) ---\n" + backend.logs.join("").slice(-3000));
    }
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? `\nTout est vert : ${passed} contrôles.` : `\n${failures} échec(s), ${passed} réussi(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nArrêt :", error?.message ?? error);
  process.exit(1);
});
