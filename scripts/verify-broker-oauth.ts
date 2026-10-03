/**
 * ============================================================
 * VÉRIFICATION DE BOUT EN BOUT — connexion Alpaca OAuth
 * ============================================================
 *
 * Lance un FAUX serveur Alpaca en local, démarre le vrai backend branché
 * dessus, puis rejoue le parcours complet par HTTP : ouverture, rappel,
 * lecture, rejeu, refus, code invalide, compte déjà relié, révocation,
 * déconnexion. Vérifie aussi qu'aucun jeton ne sort dans une réponse ni dans
 * les journaux, et que le serveur démarre SANS configuration Alpaca.
 *
 * Aucun appel à Alpaca réel, aucun identifiant requis.
 *
 *   npx tsx scripts/verify-broker-oauth.ts
 *
 * Écrit en base (tables investing.oauth_states et broker_connections) pour
 * deux utilisateurs existants, et nettoie ce qu'il a créé. Refuse de tourner
 * si ces utilisateurs ont déjà une connexion : il ne touche jamais à une
 * donnée qu'il n'a pas créée.
 */
import crypto from "crypto";
import http from "http";
import { spawn, type ChildProcess } from "child_process";

const FAKE_ALPACA_PORT = 4799;
const BACKEND_PORT = 3399;
const UNCONFIGURED_PORT = 3398;
const FAKE = `http://127.0.0.1:${FAKE_ALPACA_PORT}`;
const API = `http://127.0.0.1:${BACKEND_PORT}/api/v1`;

const GOOD_CODE = "good-code";
const TOKEN = `fake-token-${crypto.randomBytes(8).toString("hex")}`;
const ACCOUNT = { id: "acc-7f3e", account_number: "PA3XK9QZ4T1M" };
const RETURN_URL = "http://localhost:8081/connect/alpaca";

/* Variables du serveur testé, posées AVANT tout import du backend. */
const brokerEnv: Record<string, string> = {
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
  MOBILE_RETURN_URL_ALLOWLIST: "amara:,http://localhost:8081",
  // Teste le mode OAuth : jamais le compte partagé de .env.development.
  ALPACA_KEY: "",
  ALPACA_SECRET: "",
  ALPACA_KEY_ENVIRONMENT: ""
};
Object.assign(process.env, brokerEnv);

/* ---------------------------------------------------------------- */

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

/* Faux Alpaca : échange de code et lecture de compte. */
let revoked = false;
const tokenRequests: URLSearchParams[] = [];

const fakeAlpaca = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "POST" && req.url === "/oauth/token") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      tokenRequests.push(form);
      if (form.get("code") !== GOOD_CODE || form.get("client_secret") !== "test-secret") {
        return send(401, { message: "invalid_grant" });
      }
      send(200, { access_token: TOKEN, token_type: "bearer", scope: "trading" });
    });
    return;
  }

  if (req.method === "GET" && req.url === "/v2/account") {
    if (revoked || req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(401, { message: "unauthorized" });
    }
    return send(200, {
      ...ACCOUNT,
      status: "ACTIVE",
      currency: "USD",
      cash: "254.30",
      buying_power: "320.00",
      trading_blocked: false,
      account_blocked: false,
      trade_suspended_by_user: false
    });
  }

  send(404, { message: "not found" });
});

function startBackend(port: number, env: Record<string, string>) {
  const logs: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, SERVER_PORT: String(port), NODE_ENV: "development" },
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
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Délai dépassé en attendant ${url}`);
}

function stop(child: ChildProcess) {
  if (!child.killed) child.kill();
}

async function main() {
  const { prisma } = await import("../src/lib/prisma.js");
  const { generateToken } = await import("../src/lib/jsonwebtoken.js");
  const { isAllowedReturnUrl, BrokerConnectionService } = await import(
    "../src/modules/broker/broker.service.js"
  );
  const cipher = await import("../src/lib/crypto/token-cipher.js");

  const users = await prisma.user.findMany({
    select: { user_id: true },
    orderBy: { created_at: "asc" },
    take: 2
  });
  if (users.length < 2) throw new Error("Deux utilisateurs existants sont nécessaires.");
  const [alice, bob] = users.map((u) => u.user_id);

  const existing = await prisma.brokerConnection.count({
    where: { userId: { in: [alice, bob] } }
  });
  if (existing > 0) {
    throw new Error("Ces utilisateurs ont déjà une connexion : test annulé pour ne rien écraser.");
  }

  const aliceJwt = await generateToken({ user_id: alice });
  const bobJwt = await generateToken({ user_id: bob });

  const call = (path: string, jwt: string | null, init: RequestInit = {}) =>
    fetch(`${API}${path}`, {
      ...init,
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        ...(init.headers ?? {})
      }
    });

  const authorize = async (jwt: string, body: object) => {
    const response = await call("/broker/alpaca/authorize", jwt, {
      method: "POST",
      body: JSON.stringify(body)
    });
    return { response, json: (await response.json()) as any };
  };

  const stateOf = (authorizationUrl: string) =>
    new URL(authorizationUrl).searchParams.get("state") ?? "";

  const callback = async (query: string) => {
    const response = await fetch(`${API}/broker/alpaca/callback?${query}`, {
      redirect: "manual"
    });
    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
      text: await response.text()
    };
  };

  const everything: string[] = [];
  const read = async (response: Response) => {
    const text = await response.text();
    everything.push(text);
    return text ? JSON.parse(text) : null;
  };

  let backend: ReturnType<typeof startBackend> | null = null;
  let unconfigured: ReturnType<typeof startBackend> | null = null;

  try {
    /* ============================================================ */
    console.log("\nContrôles unitaires");

    const allow = ["amara:", "http://localhost:8081"];
    check("amara://connect/alpaca accepté", isAllowedReturnUrl("amara://connect/alpaca", allow));
    check("http://localhost:8081/… accepté", isAllowedReturnUrl(RETURN_URL, allow));
    check(
      "http://localhost:8081.attaquant.com refusé",
      !isAllowedReturnUrl("http://localhost:8081.attaquant.com/x", allow)
    );
    check("https://attaquant.com refusé", !isAllowedReturnUrl("https://attaquant.com", allow));
    check("javascript: refusé", !isAllowedReturnUrl("javascript:alert(1)", allow));
    check(
      "identifiants dans l'URL refusés",
      !isAllowedReturnUrl("http://user:pw@localhost:8081/x", allow)
    );
    check("port différent refusé", !isAllowedReturnUrl("http://localhost:9999/x", allow));

    const ring = {
      activeId: "k2",
      byId: new Map([
        ["k1", crypto.randomBytes(32)],
        ["k2", crypto.randomBytes(32)]
      ])
    };
    const owner = { userId: alice, provider: "ALPACA_OAUTH", environment: "PAPER" };
    const sealed = cipher.encryptToken("secret-token", owner, ring);
    check("chiffré sans le jeton en clair", !sealed.ciphertext.includes("secret-token"));
    check("déchiffrement correct", cipher.decryptToken(sealed, owner, ring) === "secret-token");

    let aadRejected = false;
    try {
      cipher.decryptToken(sealed, { ...owner, userId: bob }, ring);
    } catch {
      aadRejected = true;
    }
    check("chiffré greffé sur un autre utilisateur : illisible", aadRejected);

    let envRejected = false;
    try {
      cipher.decryptToken(sealed, { ...owner, environment: "LIVE" }, ring);
    } catch {
      envRejected = true;
    }
    check("chiffré paper relu en live : illisible", envRejected);

    const oldSealed = cipher.encryptToken("t", owner, { ...ring, activeId: "k1" });
    check("ancienne clé encore déchiffrable", cipher.decryptToken(oldSealed, owner, ring) === "t");
    check("rechiffrement signalé après rotation", cipher.needsReencryption(oldSealed, ring));

    /* ============================================================ */
    console.log("\nDémarrage");

    await new Promise<void>((r) => fakeAlpaca.listen(FAKE_ALPACA_PORT, "127.0.0.1", () => r()));
    backend = startBackend(BACKEND_PORT, brokerEnv);
    await waitFor(`http://127.0.0.1:${BACKEND_PORT}/health`);
    check("backend démarré avec la configuration courtier", true);

    /* ============================================================ */
    console.log("\nAuthentification et validation");

    check("sans session : 401", (await call("/broker/connection", null)).status === 401);

    const initial = await read(await call("/broker/connection", aliceJwt));
    check("état initial NOT_CONNECTED", initial?.data?.status === "NOT_CONNECTED", initial);

    const badEnv = await call("/broker/connection?environment=FOO", aliceJwt);
    check("environnement inconnu : 400", badEnv.status === 400);

    const evil = await authorize(aliceJwt, { returnUrl: "https://attaquant.com/vol" });
    check(
      "retour hors liste blanche : 400 INVALID_RETURN_URL",
      evil.response.status === 400 && evil.json?.error?.code === "INVALID_RETURN_URL",
      evil.json
    );

    const lookalike = await authorize(aliceJwt, { returnUrl: "http://localhost:8081.attaquant.com/" });
    check("hôte ressemblant refusé", lookalike.response.status === 400);

    /* ============================================================ */
    console.log("\nParcours nominal");

    const opened = await authorize(aliceJwt, { returnUrl: RETURN_URL });
    check("ouverture : 201", opened.response.status === 201, opened.json);
    const authUrl = new URL(opened.json.data.authorizationUrl);
    check("response_type=code", authUrl.searchParams.get("response_type") === "code");
    check("scope=trading", authUrl.searchParams.get("scope") === "trading");
    check("env=paper explicite", authUrl.searchParams.get("env") === "paper");
    check("client_secret absent de l'URL", !authUrl.toString().includes("test-secret"));
    const state = stateOf(opened.json.data.authorizationUrl);
    check("state de 43 caractères", state.length === 43);

    const done = await callback(`code=${GOOD_CODE}&state=${state}`);
    check(
      "rappel : 302 vers l'app avec result=connected",
      done.status === 302 && done.location === `${RETURN_URL}?result=connected`,
      done
    );
    check("aucun jeton dans la redirection", !done.location.includes(TOKEN));
    check(
      "échange avec le redirect_uri enregistré",
      tokenRequests.at(-1)?.get("redirect_uri") === brokerEnv.ALPACA_OAUTH_REDIRECT_URI
    );

    const replay = await callback(`code=${GOOD_CODE}&state=${state}`);
    check("rejeu du même state : result=expired", replay.location.endsWith("result=expired"), replay);

    const connected = await read(await call("/broker/connection", aliceJwt));
    check("statut CONNECTED", connected?.data?.status === "CONNECTED", connected);
    check("numéro masqué « •••• 4T1M »", connected?.data?.accountNumber === "•••• 4T1M", connected);
    check("périmètres [trading]", JSON.stringify(connected?.data?.scopes) === '["trading"]');
    check("paper: true", connected?.data?.paper === true);

    const row = await prisma.brokerConnection.findFirst({ where: { userId: alice } });
    check("jeton chiffré en base", !!row?.accessTokenCiphertext && !row.accessTokenCiphertext.includes(TOKEN));
    check(
      "empreinte SHA-256 correcte",
      row?.accessTokenFingerprint === crypto.createHash("sha256").update(TOKEN).digest("hex")
    );
    check("identifiant de clé enregistré", row?.encryptionKeyId === "test-key");

    const live = await read(await call("/broker/connection?environment=LIVE", aliceJwt));
    check("LIVE reste indépendant : NOT_CONNECTED", live?.data?.status === "NOT_CONNECTED", live);

    const liveOpen = await authorize(aliceJwt, { returnUrl: RETURN_URL, environment: "LIVE" });
    check(
      "ouverture LIVE : env=live",
      new URL(liveOpen.json.data.authorizationUrl).searchParams.get("env") === "live"
    );

    /* ============================================================ */
    console.log("\nÉchecs");

    const again = await authorize(aliceJwt, { returnUrl: RETURN_URL });
    const denied = await callback(`error=access_denied&state=${stateOf(again.json.data.authorizationUrl)}`);
    check("refus de l'utilisateur : result=denied", denied.location.endsWith("result=denied"), denied);

    const retry = await authorize(aliceJwt, { returnUrl: RETURN_URL });
    const badCode = await callback(`code=mauvais&state=${stateOf(retry.json.data.authorizationUrl)}`);
    check("code refusé : result=error", badCode.location.endsWith("result=error"), badCode);
    const afterFailure = await read(await call("/broker/connection", aliceJwt));
    check(
      "une tentative ratée ne dégrade pas la connexion active",
      afterFailure?.data?.status === "CONNECTED",
      afterFailure
    );

    const expiring = await authorize(aliceJwt, { returnUrl: RETURN_URL });
    const expiringState = stateOf(expiring.json.data.authorizationUrl);
    await prisma.oAuthState.update({
      where: { state: expiringState },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    const late = await callback(`code=${GOOD_CODE}&state=${expiringState}`);
    check("state expiré : result=expired", late.location.endsWith("result=expired"), late);

    const forged = await callback(`code=${GOOD_CODE}&state=inventé`);
    check("state inconnu : page 400, aucune redirection", forged.status === 400 && !forged.location);
    check("page en HTML échappé", forged.text.includes("<h1>") && !forged.text.includes("<script"));

    const bobOpen = await authorize(bobJwt, { returnUrl: RETURN_URL });
    const bobDone = await callback(`code=${GOOD_CODE}&state=${stateOf(bobOpen.json.data.authorizationUrl)}`);
    check(
      "même compte Alpaca pour un 2ᵉ utilisateur : result=already_linked",
      bobDone.location.endsWith("result=already_linked"),
      bobDone
    );
    const bobState = await read(await call("/broker/connection", bobJwt));
    check("le 2ᵉ utilisateur n'est pas relié", bobState?.data?.status !== "CONNECTED", bobState);

    /* ============================================================ */
    console.log("\nAccès authentifié et révocation (en processus)");

    const service = new BrokerConnectionService({ prisma });
    const account = await service.withBroker(alice, "PAPER", (ctx, adapters) =>
      adapters.provider.getAccount(ctx)
    );
    check("withBroker déchiffre et lit le compte", account.accountNumber === ACCOUNT.account_number);
    check("montants en chaînes", account.cash === "254.30" && typeof account.buyingPower === "string");

    revoked = true;
    let revokedCode = "";
    try {
      await service.withBroker(alice, "PAPER", (ctx, adapters) => adapters.provider.getAccount(ctx));
    } catch (error: any) {
      revokedCode = error?.code;
    }
    check("jeton refusé par Alpaca : BROKER_UNAUTHORIZED", revokedCode === "BROKER_UNAUTHORIZED");
    const afterRevoke = await read(await call("/broker/connection", aliceJwt));
    check("connexion passée en REVOKED", afterRevoke?.data?.status === "REVOKED", afterRevoke);
    check("numéro non exposé hors CONNECTED", afterRevoke?.data?.accountNumber === null);

    /* ============================================================ */
    console.log("\nDéconnexion");

    const removed = await call("/broker/connection", aliceJwt, { method: "DELETE" });
    check("DELETE : 204", removed.status === 204);
    const afterDelete = await prisma.brokerConnection.findFirst({ where: { userId: alice } });
    check("jeton effacé en base", afterDelete?.accessTokenCiphertext === null);
    check("statut NOT_CONNECTED", afterDelete?.status === "NOT_CONNECTED");
    const twice = await call("/broker/connection", aliceJwt, { method: "DELETE" });
    check("DELETE idempotent", twice.status === 204);

    let notConnected = "";
    try {
      await service.withBroker(alice, "PAPER", async () => null);
    } catch (error: any) {
      notConnected = error?.code;
    }
    check("withBroker après déconnexion : BROKER_NOT_CONNECTED", notConnected === "BROKER_NOT_CONNECTED");

    /* ============================================================ */
    console.log("\nFuites");

    check("aucun jeton dans les réponses JSON", !everything.some((t) => t.includes(TOKEN)));
    check("aucun jeton dans les journaux du serveur", !backend.logs.join("").includes(TOKEN));
    check("aucun client_secret dans les journaux", !backend.logs.join("").includes("test-secret"));

    /* ============================================================ */
    console.log("\nSans configuration Alpaca");

    unconfigured = startBackend(UNCONFIGURED_PORT, {
      ...Object.fromEntries(Object.keys(brokerEnv).map((k) => [k, ""]))
    });
    await waitFor(`http://127.0.0.1:${UNCONFIGURED_PORT}/health`);
    check("le serveur démarre quand même", true);
    const noConfig = await fetch(`http://127.0.0.1:${UNCONFIGURED_PORT}/api/v1/broker/connection`, {
      headers: { Authorization: `Bearer ${aliceJwt}` }
    });
    const noConfigJson = (await noConfig.json()) as any;
    check(
      "routes courtier : 503 BROKER_NOT_CONFIGURED",
      noConfig.status === 503 && noConfigJson?.error?.code === "BROKER_NOT_CONFIGURED",
      noConfigJson
    );
    const market = await fetch(`http://127.0.0.1:${UNCONFIGURED_PORT}/health`);
    check("le reste de l'API répond", market.ok);
  } finally {
    await prisma.oAuthState.deleteMany({ where: { userId: { in: [alice, bob] } } });
    await prisma.brokerConnection.deleteMany({ where: { userId: { in: [alice, bob] } } });
    if (backend) stop(backend.child);
    if (unconfigured) stop(unconfigured.child);
    fakeAlpaca.close();
    await prisma.$disconnect();
    if (failures > 0 && backend) {
      console.log("\n--- journaux du backend (fin) ---\n" + backend.logs.join("").slice(-3000));
    }
  }

  console.log(failures === 0 ? "\nTout est vert." : `\n${failures} contrôle(s) en échec.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nArrêt :", error?.message ?? error);
  process.exit(1);
});
