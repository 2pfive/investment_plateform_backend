import crypto from "crypto";
import { prisma as defaultPrisma } from "@/lib/prisma.js";
import {
  brokerConfig,
  type BrokerConfig,
  type BrokerEnvironmentName
} from "@/config/broker.config.js";
import {
  decryptToken,
  encryptToken,
  needsReencryption,
  tokenFingerprint,
  type TokenBinding
} from "@/lib/crypto/token-cipher.js";
import {
  createBrokerAdapters,
  sharedAccountCredential,
  type BrokerAdapters
} from "@/infrastructure/brokers/broker.factory.js";
import type { BrokerContext } from "@/ports/broker.port.js";
import { BrokerError } from "@/ports/broker.errors.js";

/**
 * ============================================================
 * CONNEXION DU COMPTE DE COURTAGE
 * ============================================================
 *
 * Relie un compte AMARA à un compte Alpaca par OAuth, puis fournit aux
 * phases suivantes (ordres, positions) un contexte authentifié.
 *
 * Invariants tenus ici, et nulle part ailleurs :
 *
 * - le jeton n'existe en clair qu'en mémoire, le temps d'un appel ;
 * - un `state` ne sert qu'une fois, même sous requêtes concurrentes ;
 * - l'adresse de retour vers l'application est validée AVANT d'être
 *   enregistrée, et c'est la seule jamais utilisée pour rediriger ;
 * - un même compte Alpaca n'est relié qu'à un seul compte AMARA par
 *   environnement.
 */

const PROVIDER = "ALPACA_OAUTH" as const;

/** Format d'un `state` émis ici : 32 octets en base64url. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type CallbackResult = "connected" | "denied" | "expired" | "already_linked" | "error";

export type CallbackOutcome =
  | { kind: "redirect"; location: string }
  /** Aucune adresse de retour connue : on ne peut qu'afficher une page. */
  | { kind: "page"; status: number; title: string; body: string };

/** Ce que le mobile reçoit. Aucun jeton, sous aucun nom. */
export interface BrokerConnectionDto {
  broker: "ALPACA";
  environment: BrokerEnvironmentName;
  paper: boolean;
  status:
    | "NOT_CONNECTED"
    | "CONNECTING"
    | "CONNECTED"
    | "EXPIRED"
    | "REVOKED"
    | "ERROR";
  /** Quatre derniers caractères seulement, précédés de puces. */
  accountNumber: string | null;
  connectedAt: string | null;
  scopes: string[];
}

interface Dependencies {
  prisma?: typeof defaultPrisma;
  /** Surchargeable en test ; par défaut, construits depuis la configuration. */
  adapters?: (config: BrokerConfig) => BrokerAdapters;
  now?: () => Date;
}

/**
 * La destination de retour est-elle autorisée ?
 *
 * Comparaison sur l'URL analysée, jamais par préfixe de chaîne. Une entrée
 * terminée par `:` autorise tout un schéma (`amara:`) ; sinon, schéma, hôte
 * et port doivent correspondre exactement.
 */
export function isAllowedReturnUrl(candidate: string, allowlist: string[]): boolean {
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  // Aucune chance de contrebande par les identifiants ou le fragment.
  if (url.username || url.password || url.hash) return false;

  return allowlist.some((entry) => {
    if (entry.endsWith(":") && !entry.includes("/")) {
      return url.protocol === entry.toLowerCase();
    }

    try {
      const allowed = new URL(entry);
      return (
        url.protocol === allowed.protocol &&
        url.host.toLowerCase() === allowed.host.toLowerCase()
      );
    } catch {
      return false;
    }
  });
}

function withResult(returnUrl: string, result: CallbackResult): string {
  const url = new URL(returnUrl);
  url.searchParams.set("result", result);
  return url.toString();
}

function maskAccountNumber(last4: string | null): string | null {
  return last4 ? `•••• ${last4}` : null;
}

export class BrokerConnectionService {
  private readonly prisma: typeof defaultPrisma;
  private readonly adaptersFor: (config: BrokerConfig) => BrokerAdapters;
  private readonly now: () => Date;

  constructor(deps: Dependencies = {}) {
    this.prisma = deps.prisma ?? defaultPrisma;
    this.adaptersFor = deps.adapters ?? createBrokerAdapters;
    this.now = deps.now ?? (() => new Date());
  }

  /* ========================================================
   * CONFIGURATION ET ENVIRONNEMENT
   * ======================================================== */

  private requireConfig(): BrokerConfig {
    const result = brokerConfig();

    if (!result.ok) {
      // Les noms de variables aident l'exploitant ; ils ne partent pas au
      // client.
      console.error(
        "[broker] configuration invalide :",
        result.problems.join(" ; ")
      );
      throw new BrokerError(
        "BROKER_NOT_CONFIGURED",
        "La connexion au courtier n’est pas disponible pour le moment.",
        503
      );
    }

    return result.config;
  }

  /** Configuration complète, OAuth compris : pour les routes d'autorisation. */
  private requireOAuthConfig(): BrokerConfig {
    const config = this.requireConfig();

    if (!config.oauthConfigured) {
      console.error("[broker] OAuth non configuré : ALPACA_OAUTH_* manquants");
      throw new BrokerError(
        "BROKER_NOT_CONFIGURED",
        "La connexion au courtier n’est pas disponible pour le moment.",
        503
      );
    }

    return config;
  }

  private resolveEnvironment(
    config: BrokerConfig,
    requested?: string
  ): BrokerEnvironmentName {
    const environment = (requested ?? config.defaultEnvironment).toUpperCase();

    if (environment !== "PAPER" && environment !== "LIVE") {
      throw new BrokerError(
        "INVALID_REQUEST",
        "Environnement inconnu : attendu PAPER ou LIVE.",
        400
      );
    }

    if (!config.allowedEnvironments.includes(environment)) {
      throw new BrokerError(
        "BROKER_ENVIRONMENT_NOT_ALLOWED",
        environment === "LIVE"
          ? "Le trading réel n’est pas ouvert sur ce serveur."
          : "Le trading simulé n’est pas ouvert sur ce serveur.",
        403
      );
    }

    return environment;
  }

  /**
   * Environnement effectif d'une requête : celui demandé, ou le défaut du
   * serveur, après contrôle qu'il est ouvert. Public pour que les services
   * appelants (ordres) figent la même valeur que `withBroker` utilisera.
   */
  environmentFor(requested?: string): BrokerEnvironmentName {
    return this.resolveEnvironment(this.requireConfig(), requested);
  }

  /* ========================================================
   * 1. OUVERTURE DE L'AUTORISATION
   * ======================================================== */

  async startAuthorization(
    userId: string,
    input: { returnUrl: string; environment?: string }
  ): Promise<{
    authorizationUrl: string;
    expiresAt: string;
    environment: BrokerEnvironmentName;
  }> {
    const config = this.requireOAuthConfig();
    const environment = this.resolveEnvironment(config, input.environment);

    if (!isAllowedReturnUrl(input.returnUrl, config.returnUrlAllowlist)) {
      throw new BrokerError(
        "INVALID_RETURN_URL",
        "Adresse de retour non autorisée.",
        400
      );
    }

    const now = this.now();
    const expiresAt = new Date(now.getTime() + config.stateTtlSeconds * 1000);
    const state = crypto.randomBytes(32).toString("base64url");

    // Ménage opportuniste : les states expirés de cet utilisateur ne
    // serviront plus. Borné à son propre compte, donc sans coût global.
    await this.prisma.oAuthState.deleteMany({
      where: { userId, expiresAt: { lt: now } }
    });

    await this.prisma.oAuthState.create({
      data: {
        state,
        userId,
        provider: PROVIDER,
        environment,
        redirectUri: config.redirectUri,
        returnUrl: input.returnUrl,
        expiresAt
      }
    });

    const { authorization } = this.adaptersFor(config);

    return {
      authorizationUrl: authorization.buildAuthorizationUrl({
        state,
        redirectUri: config.redirectUri,
        environment,
        scopes: config.scopes
      }),
      expiresAt: expiresAt.toISOString(),
      environment
    };
  }

  /* ========================================================
   * 2. RAPPEL D'ALPACA
   * ========================================================
   *
   * Appelé par le navigateur de l'utilisateur, sans session AMARA : c'est le
   * `state` qui authentifie la requête. Ne lève jamais — chaque issue devient
   * une redirection vers l'application, ou une page quand on ne sait pas où
   * rediriger.
   */

  async completeAuthorization(query: {
    code?: unknown;
    state?: unknown;
    error?: unknown;
  }): Promise<CallbackOutcome> {
    const invalidLink: CallbackOutcome = {
      kind: "page",
      status: 400,
      title: "Lien de connexion invalide",
      body: "Ce lien a expiré ou a déjà été utilisé. Revenez dans l’application AMARA et relancez la connexion."
    };

    const state = typeof query.state === "string" ? query.state : "";
    if (!STATE_PATTERN.test(state)) return invalidLink;

    const record = await this.prisma.oAuthState.findUnique({ where: { state } });
    if (!record || !record.returnUrl) return invalidLink;

    const returnUrl = record.returnUrl;
    const now = this.now();

    /*
     * Consommation atomique : la condition porte sur `consumedAt` ET
     * `expiresAt`. Deux rappels simultanés portant le même `state` ne
     * peuvent pas tous deux obtenir `count === 1`.
     */
    const consumed = await this.prisma.oAuthState.updateMany({
      where: { id: record.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now }
    });

    if (consumed.count !== 1) {
      return { kind: "redirect", location: withResult(returnUrl, "expired") };
    }

    // Refus explicite de l'utilisateur sur l'écran d'Alpaca.
    if (query.error !== undefined) {
      return { kind: "redirect", location: withResult(returnUrl, "denied") };
    }

    const code = typeof query.code === "string" ? query.code : "";
    if (!code || code.length > 512) {
      return { kind: "redirect", location: withResult(returnUrl, "error") };
    }

    let config: BrokerConfig;
    try {
      config = this.requireOAuthConfig();
    } catch {
      return { kind: "redirect", location: withResult(returnUrl, "error") };
    }

    const environment = record.environment as BrokerEnvironmentName;
    const binding: TokenBinding = {
      userId: record.userId,
      provider: PROVIDER,
      environment
    };

    try {
      const { authorization, provider } = this.adaptersFor(config);

      const granted = await authorization.exchangeCode({
        code,
        // La valeur enregistrée à l'ouverture, pas la configuration courante :
        // Alpaca exige l'identité exacte.
        redirectUri: record.redirectUri
      });

      // Vérifie que le jeton fonctionne sur l'environnement visé, et récupère
      // l'identité du compte. Un jeton qui ne lit pas le compte n'est pas
      // enregistré.
      const account = await provider.getAccount({
        environment,
        accessToken: granted.accessToken
      });

      const takenBySomeoneElse = await this.prisma.brokerConnection.findFirst({
        where: {
          provider: PROVIDER,
          environment,
          externalAccountId: account.externalId,
          status: "CONNECTED",
          NOT: { userId: record.userId }
        },
        select: { id: true }
      });

      if (takenBySomeoneElse) {
        console.warn("[broker] compte Alpaca déjà relié à un autre utilisateur");
        return { kind: "redirect", location: withResult(returnUrl, "already_linked") };
      }

      const encrypted = encryptToken(granted.accessToken, binding, config.tokenKeys);

      await this.prisma.brokerConnection.upsert({
        where: {
          userId_provider_environment: {
            userId: record.userId,
            provider: PROVIDER,
            environment
          }
        },
        create: {
          userId: record.userId,
          provider: PROVIDER,
          environment,
          status: "CONNECTED",
          externalAccountId: account.externalId,
          accountLast4: account.accountNumber.slice(-4),
          accessTokenCiphertext: encrypted.ciphertext,
          encryptionKeyId: encrypted.keyId,
          accessTokenFingerprint: tokenFingerprint(granted.accessToken),
          scope: granted.scope,
          connectedAt: now,
          lastSyncedAt: now
        },
        update: {
          status: "CONNECTED",
          externalAccountId: account.externalId,
          accountLast4: account.accountNumber.slice(-4),
          accessTokenCiphertext: encrypted.ciphertext,
          encryptionKeyId: encrypted.keyId,
          accessTokenFingerprint: tokenFingerprint(granted.accessToken),
          scope: granted.scope,
          refreshTokenCiphertext: null,
          tokenExpiresAt: null,
          connectedAt: now,
          lastSyncedAt: now,
          revokedAt: null,
          lastErrorAt: null,
          lastErrorMsg: null
        }
      });

      return { kind: "redirect", location: withResult(returnUrl, "connected") };
    } catch (error) {
      await this.recordFailure(record.userId, environment, error);
      return { kind: "redirect", location: withResult(returnUrl, "error") };
    }
  }

  /**
   * Trace un échec de connexion.
   *
   * Une connexion déjà active n'est PAS dégradée : une nouvelle tentative
   * ratée ne rend pas invalide le jeton qui fonctionnait. Seule l'erreur est
   * notée. Sans connexion préalable, une ligne `ERROR` est créée pour que le
   * mobile puisse le dire.
   */
  private async recordFailure(
    userId: string,
    environment: BrokerEnvironmentName,
    error: unknown
  ): Promise<void> {
    const message =
      error instanceof BrokerError ? error.code : "UNEXPECTED_ERROR";

    if (!(error instanceof BrokerError)) {
      console.error("[broker] échec inattendu au rappel OAuth :", (error as Error)?.name);
    }

    try {
      const now = this.now();
      await this.prisma.brokerConnection.upsert({
        where: {
          userId_provider_environment: { userId, provider: PROVIDER, environment }
        },
        create: {
          userId,
          provider: PROVIDER,
          environment,
          status: "ERROR",
          lastErrorAt: now,
          lastErrorMsg: message
        },
        update: { lastErrorAt: now, lastErrorMsg: message }
      });
    } catch {
      // La trace d'erreur ne doit pas masquer l'erreur d'origine.
    }
  }

  /* ========================================================
   * 3. LECTURE ET RUPTURE
   * ======================================================== */

  async getConnection(
    userId: string,
    requestedEnvironment?: string
  ): Promise<BrokerConnectionDto> {
    const config = this.requireConfig();
    const environment = this.resolveEnvironment(config, requestedEnvironment);

    if (config.sharedAccount) {
      return this.sharedConnectionStatus(config, environment);
    }

    const connection = await this.prisma.brokerConnection.findUnique({
      where: {
        userId_provider_environment: { userId, provider: PROVIDER, environment }
      },
      select: {
        status: true,
        accountLast4: true,
        connectedAt: true,
        scope: true
      }
    });

    return {
      broker: "ALPACA",
      environment,
      paper: environment === "PAPER",
      status: connection?.status ?? "NOT_CONNECTED",
      accountNumber:
        connection?.status === "CONNECTED"
          ? maskAccountNumber(connection.accountLast4)
          : null,
      connectedAt:
        connection?.status === "CONNECTED" && connection.connectedAt
          ? connection.connectedAt.toISOString()
          : null,
      scopes: connection?.scope ? connection.scope.split(/\s+/).filter(Boolean) : []
    };
  }

  /**
   * État du compte partagé : relu chez Alpaca, ce qui vérifie les clés au
   * passage. Le même pour tous les utilisateurs.
   */
  private async sharedConnectionStatus(
    config: BrokerConfig,
    environment: BrokerEnvironmentName
  ): Promise<BrokerConnectionDto> {
    const shared = config.sharedAccount!;
    const base = {
      broker: "ALPACA" as const,
      environment,
      paper: environment === "PAPER",
      scopes: ["trading"]
    };

    if (environment !== shared.environment) {
      return { ...base, status: "NOT_CONNECTED", accountNumber: null, connectedAt: null };
    }

    try {
      const account = await this.adaptersFor(config).provider.getAccount({
        environment,
        accessToken: sharedAccountCredential(shared)
      });
      return {
        ...base,
        status: "CONNECTED",
        accountNumber: maskAccountNumber(account.accountNumber.slice(-4)),
        connectedAt: null
      };
    } catch (error) {
      if (!(error instanceof BrokerError)) throw error;
      // Clés refusées : ERROR. Alpaca injoignable : on ne sait pas, on le dit.
      if (error.code !== "BROKER_UNAUTHORIZED") throw error;
      return { ...base, status: "ERROR", accountNumber: null, connectedAt: null };
    }
  }

  /**
   * Efface le jeton chez AMARA. Idempotent.
   *
   * Ne révoque rien chez Alpaca — la documentation ne décrit pas de point de
   * révocation. Le compte de l'utilisateur, ses titres et ses espèces ne sont
   * pas touchés ; il peut retirer l'accès depuis son espace Alpaca.
   */
  async disconnect(userId: string, requestedEnvironment?: string): Promise<void> {
    const config = this.requireConfig();
    const environment = this.resolveEnvironment(config, requestedEnvironment);

    await this.prisma.brokerConnection.updateMany({
      where: { userId, provider: PROVIDER, environment },
      data: {
        status: "NOT_CONNECTED",
        accessTokenCiphertext: null,
        encryptionKeyId: null,
        accessTokenFingerprint: null,
        refreshTokenCiphertext: null,
        tokenExpiresAt: null,
        scope: null,
        revokedAt: this.now()
      }
    });
  }

  /* ========================================================
   * 4. ACCÈS AUTHENTIFIÉ — pour les phases suivantes
   * ======================================================== */

  /**
   * Exécute une opération sur le compte relié de l'utilisateur.
   *
   * Point d'entrée unique des services d'ordres et de positions : ils ne
   * voient jamais le chiffré, ni la clé. Si Alpaca refuse le jeton, la
   * connexion passe en `REVOKED` — le mobile le saura au prochain affichage
   * plutôt qu'à l'ordre suivant.
   */
  async withBroker<T>(
    userId: string,
    requestedEnvironment: string | undefined,
    operation: (
      context: BrokerContext,
      adapters: BrokerAdapters,
      connection: { id: string; environment: BrokerEnvironmentName }
    ) => Promise<T>
  ): Promise<T> {
    const config = this.requireConfig();
    const environment = this.resolveEnvironment(config, requestedEnvironment);

    if (config.sharedAccount) {
      const shared = config.sharedAccount;
      if (environment !== shared.environment) {
        throw new BrokerError(
          "BROKER_NOT_CONNECTED",
          environment === "LIVE"
            ? "Le compte de courtage AMARA est en mode simulé."
            : "Le compte de courtage AMARA est en argent réel : choisissez LIVE.",
          409
        );
      }

      /*
       * Une ligne par utilisateur, sans jeton : les ordres s'y rattachent, et
       * c'est par elle que la liste et le suivi retrouvent leur environnement.
       */
      const row = await this.prisma.brokerConnection.upsert({
        where: {
          userId_provider_environment: { userId, provider: PROVIDER, environment }
        },
        create: {
          userId,
          provider: PROVIDER,
          environment,
          status: "CONNECTED",
          scope: "trading",
          connectedAt: this.now()
        },
        update: { status: "CONNECTED", lastSyncedAt: this.now() },
        select: { id: true }
      });

      return operation(
        { environment, accessToken: sharedAccountCredential(shared) },
        this.adaptersFor(config),
        { id: row.id, environment }
      );
    }

    const connection = await this.prisma.brokerConnection.findUnique({
      where: {
        userId_provider_environment: { userId, provider: PROVIDER, environment }
      }
    });

    if (
      !connection ||
      connection.status !== "CONNECTED" ||
      !connection.accessTokenCiphertext ||
      !connection.encryptionKeyId
    ) {
      throw new BrokerError(
        "BROKER_NOT_CONNECTED",
        "Connectez votre compte de courtage pour continuer.",
        409
      );
    }

    const binding: TokenBinding = { userId, provider: PROVIDER, environment };
    const stored = {
      ciphertext: connection.accessTokenCiphertext,
      keyId: connection.encryptionKeyId
    };

    let accessToken: string;
    try {
      accessToken = decryptToken(stored, binding, config.tokenKeys);
    } catch {
      console.error("[broker] jeton indéchiffrable pour une connexion active");
      await this.prisma.brokerConnection.update({
        where: { id: connection.id },
        data: { status: "ERROR", lastErrorAt: this.now(), lastErrorMsg: "TOKEN_UNREADABLE" }
      });
      throw new BrokerError(
        "BROKER_NOT_CONNECTED",
        "Reconnectez votre compte de courtage pour continuer.",
        409
      );
    }

    // Rotation de clé : rechiffre avec la clé active à la première utilisation.
    if (needsReencryption(stored, config.tokenKeys)) {
      const fresh = encryptToken(accessToken, binding, config.tokenKeys);
      await this.prisma.brokerConnection.update({
        where: { id: connection.id },
        data: {
          accessTokenCiphertext: fresh.ciphertext,
          encryptionKeyId: fresh.keyId
        }
      });
    }

    try {
      const result = await operation(
        { environment, accessToken },
        this.adaptersFor(config),
        { id: connection.id, environment }
      );

      await this.prisma.brokerConnection.update({
        where: { id: connection.id },
        data: { lastSyncedAt: this.now() }
      });

      return result;
    } catch (error) {
      if (error instanceof BrokerError && error.code === "BROKER_UNAUTHORIZED") {
        await this.prisma.brokerConnection.update({
          where: { id: connection.id },
          data: {
            status: "REVOKED",
            revokedAt: this.now(),
            lastErrorAt: this.now(),
            lastErrorMsg: error.code
          }
        });
      }
      throw error;
    }
  }
}
