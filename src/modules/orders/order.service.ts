import crypto from "crypto";
import Decimal from "decimal.js";
import { prisma as defaultPrisma } from "@/lib/prisma.js";
import { ordersConfig } from "@/config/orders.config.js";
import { BrokerConnectionService } from "@/modules/broker/broker.service.js";
import { FxRateService, type FundingCurrency } from "@/modules/fx/fx.service.js";
import type {
  BrokerOrder,
  BrokerProvider,
  BrokerContext,
  MarketClock,
  OrderSideName,
  OrderStatusName
} from "@/ports/broker.port.js";
import { BrokerError } from "@/ports/broker.errors.js";
import {
  decideTransition,
  NON_TERMINAL_STATUSES,
  ORDER_DTO_SELECT,
  PENDING_CONFIRMATION,
  TERMINAL_STATUSES,
  toOrderDto,
  type OrderDto
} from "./order.dto.js";

/**
 * ============================================================
 * ORDRES EN ARGENT RÉEL
 * ============================================================
 *
 * « Investir 25 000 FCFA dans SPY » devient un ordre au marché en MONTANT
 * (`notional`, en dollars) sur le compte Alpaca de l'utilisateur.
 *
 * Trois règles tenues ici :
 *
 * 1. **Jamais deux ordres pour une intention.** Le mobile envoie une clé
 *    d'idempotence ; AMARA génère une `clientOrderId` que le courtier voit.
 *    Une requête rejouée — double tap, réseau instable — renvoie l'ordre
 *    existant au lieu d'en créer un second.
 *
 * 2. **Une issue inconnue n'est pas un échec.** Si la transmission coupe, on
 *    ne sait pas si l'ordre est parti : on le cherche par sa clé chez le
 *    courtier, et à défaut on l'annonce « en attente de confirmation ».
 *    Déclarer « échoué » un ordre peut-être exécuté pousserait à le repasser.
 *
 * 3. **L'exécution vient du courtier, jamais d'une estimation.** Quantité et
 *    prix moyen ne sont renseignés que par ce qu'Alpaca rapporte.
 */

const ENDPOINT = "POST /orders";

/** Au-delà, un ordre jamais retrouvé chez le courtier est déclaré échoué. */
const NOT_RECEIVED_AFTER_MS = 10 * 60 * 1000;

/** Au-delà, une clé restée « en cours » sans ordre est considérée abandonnée. */
const STALE_IDEMPOTENCY_MS = 60 * 1000;

/** Décimales par devise de saisie. Le franc CFA n'a pas de subdivision en usage. */
const CURRENCY_DECIMALS: Record<FundingCurrency, number> = { XAF: 0, EUR: 2, USD: 2 };

export interface OrderInput {
  symbol: string;
  side: OrderSideName;
  /** Chaîne décimale, dans la devise `currency`. */
  amount: string;
  currency: FundingCurrency;
  environment?: string;
}

export interface OrderEstimate {
  symbol: string;
  side: OrderSideName;
  environment: "PAPER" | "LIVE";
  amount: string;
  currency: FundingCurrency;
  fee: string;
  /** Unités de `currency` pour 1 USD. */
  fxRate: string;
  fxRateAt: string;
  /** Montant transmis au courtier, en dollars. */
  notionalUsd: string;
  asset: { name: string; tradable: boolean; fractionable: boolean };
  market: MarketClock | null;
}

/** Réponse HTTP à renvoyer telle quelle : les rejeux la reproduisent. */
export interface HttpOutcome {
  status: number;
  body: unknown;
  replayed?: boolean;
}

interface Dependencies {
  prisma?: typeof defaultPrisma;
  broker?: BrokerConnectionService;
  fx?: FxRateService;
  now?: () => Date;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export class OrderService {
  private readonly prisma: typeof defaultPrisma;
  private readonly broker: BrokerConnectionService;
  private readonly fx: FxRateService;
  private readonly now: () => Date;

  constructor(deps: Dependencies = {}) {
    this.prisma = deps.prisma ?? defaultPrisma;
    this.now = deps.now ?? (() => new Date());
    this.broker = deps.broker ?? new BrokerConnectionService({ prisma: this.prisma, now: this.now });
    this.fx = deps.fx ?? new FxRateService({ prisma: this.prisma, now: this.now });
  }

  /* ========================================================
   * CALCUL — commun à l'estimation et au passage
   * ======================================================== */

  /**
   * Montant saisi → montant en dollars transmis au courtier.
   *
   * Frais arrondis VERS LE HAUT dans la devise de saisie, montant en dollars
   * arrondi VERS LE BAS au cent : l'arrondi ne fait jamais investir plus que
   * ce que l'utilisateur a saisi.
   */
  private async price(input: OrderInput) {
    const settings = ordersConfig();
    const dp = CURRENCY_DECIMALS[input.currency];

    let amount: InstanceType<typeof Decimal>;
    try {
      amount = new Decimal(input.amount);
    } catch {
      throw new BrokerError("INVALID_AMOUNT", "Montant invalide.", 400);
    }
    if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > dp) {
      throw new BrokerError(
        "INVALID_AMOUNT",
        dp === 0
          ? "Montant invalide : un nombre entier de francs est attendu."
          : `Montant invalide : ${dp} décimales au plus.`,
        400
      );
    }

    const fee = amount.times(settings.feeRate).toDecimalPlaces(dp, Decimal.ROUND_UP);
    const invested = input.side === "BUY" ? amount.minus(fee) : amount;

    const quote = await this.fx.quote(input.currency);
    const notional = invested.div(quote.perUsd).toDecimalPlaces(2, Decimal.ROUND_DOWN);

    if (notional.lt(settings.minNotionalUsd)) {
      throw new BrokerError(
        "INVALID_AMOUNT",
        `Montant trop faible : le courtier exige au moins ${settings.minNotionalUsd} $ par ordre.`,
        400
      );
    }
    if (settings.maxNotionalUsd && notional.gt(settings.maxNotionalUsd)) {
      throw new BrokerError(
        "INVALID_AMOUNT",
        `Montant trop élevé : ${settings.maxNotionalUsd} $ au plus par ordre.`,
        400
      );
    }

    return {
      amount: amount.toFixed(dp),
      fee: fee.toFixed(dp),
      notionalUsd: notional.toFixed(2),
      quote
    };
  }

  /**
   * Vérifie l'actif chez le courtier et met à jour sa fiche locale.
   *
   * L'actif est relu à chaque ordre : `tradable` et `fractionable` changent
   * (suspension de cotation, retrait du fractionné), et une fiche locale
   * périmée laisserait passer un ordre voué au refus.
   */
  private async checkAsset(context: BrokerContext, provider: BrokerProvider, symbol: string) {
    const asset = await provider.getAsset(context, symbol);

    if (!asset) {
      throw new BrokerError("ASSET_NOT_FOUND", `Actif inconnu du courtier : ${symbol}.`, 404);
    }

    const local = await this.prisma.asset.upsert({
      where: { symbol: asset.symbol },
      create: {
        symbol: asset.symbol,
        name: asset.name,
        // Alpaca ne distingue pas action et ETF : un actif créé ici est noté
        // STOCK, et une fiche existante garde son type.
        assetType: "STOCK",
        exchange: asset.exchange,
        tradable: asset.tradable,
        fractionable: asset.fractionable,
        shortable: asset.shortable,
        brokerAssetId: asset.externalId,
        status: asset.active ? "ACTIVE" : "INACTIVE"
      },
      update: {
        exchange: asset.exchange,
        tradable: asset.tradable,
        fractionable: asset.fractionable,
        shortable: asset.shortable,
        brokerAssetId: asset.externalId,
        status: asset.active ? "ACTIVE" : "INACTIVE"
      },
      select: { id: true }
    });

    if (!asset.active || !asset.tradable) {
      throw new BrokerError(
        "ASSET_NOT_TRADABLE",
        `${symbol} n’est pas négociable pour le moment.`,
        422
      );
    }
    if (!asset.fractionable) {
      throw new BrokerError(
        "ASSET_NOT_FRACTIONABLE",
        `${symbol} ne peut pas être acheté par montant : seules des parts entières sont acceptées.`,
        422
      );
    }

    return { asset, assetId: local.id };
  }

  /** L'horloge renseigne l'utilisateur ; son absence ne bloque jamais un ordre. */
  private async clock(context: BrokerContext, provider: BrokerProvider) {
    try {
      return await provider.getClock(context);
    } catch {
      return null;
    }
  }

  /* ========================================================
   * ESTIMATION — sans effet
   * ======================================================== */

  async estimate(userId: string, input: OrderInput): Promise<OrderEstimate> {
    const environment = this.broker.environmentFor(input.environment);
    const priced = await this.price(input);

    return this.broker.withBroker(userId, environment, async (context, { provider }) => {
      const { asset } = await this.checkAsset(context, provider, input.symbol);

      return {
        symbol: asset.symbol,
        side: input.side,
        environment,
        amount: priced.amount,
        currency: input.currency,
        fee: priced.fee,
        fxRate: priced.quote.perUsd,
        fxRateAt: priced.quote.fetchedAt,
        notionalUsd: priced.notionalUsd,
        asset: { name: asset.name, tradable: asset.tradable, fractionable: asset.fractionable },
        market: await this.clock(context, provider)
      };
    });
  }

  /* ========================================================
   * PASSAGE D'ORDRE
   * ======================================================== */

  async placeOrder(userId: string, input: OrderInput, idempotencyKey: string): Promise<HttpOutcome> {
    const environment = this.broker.environmentFor(input.environment);

    const requestHash = sha256(
      JSON.stringify({
        symbol: input.symbol,
        side: input.side,
        amount: new Decimal(input.amount).toFixed(),
        currency: input.currency,
        environment
      })
    );

    const claim = await this.claimIdempotencyKey(userId, idempotencyKey, requestHash);
    if (claim.kind === "replay") return claim.outcome;

    const keyId = claim.id;
    let orderId: string | null = null;

    try {
      const priced = await this.price(input);

      return await this.broker.withBroker(
        userId,
        environment,
        async (context, { provider }, connection) => {
          const { asset, assetId } = await this.checkAsset(context, provider, input.symbol);
          const market = await this.clock(context, provider);
          const portfolioId = await this.portfolioFor(userId);
          const clientOrderId = `amara-${userId.slice(0, 8)}-${crypto.randomUUID()}`;

          const order = await this.prisma.order.create({
            data: {
              userId,
              portfolioId,
              assetId,
              brokerConnectionId: connection.id,
              side: input.side,
              orderType: "MARKET",
              timeInForce: "DAY",
              status: "CREATED",
              requestedAmount: priced.amount,
              requestedCurrency: input.currency,
              notional: priced.notionalUsd,
              tradingCurrency: "USD",
              fxRate: priced.quote.perUsd,
              fxRateId: priced.quote.fxRateId,
              fee: priced.fee,
              clientOrderId,
              events: { create: { toStatus: "CREATED", source: "AMARA" } }
            },
            select: { id: true }
          });
          orderId = order.id;

          await this.prisma.idempotencyKey.update({
            where: { id: keyId },
            data: { resourceType: "Order", resourceId: order.id }
          });

          const outcome = await this.transmit(context, provider, order.id, {
            symbol: asset.symbol,
            side: input.side,
            notional: priced.notionalUsd,
            clientOrderId
          }, market);

          await this.completeIdempotencyKey(keyId, outcome);
          return outcome;
        }
      );
    } catch (error) {
      if (orderId === null) {
        // Rien n'a été créé ni transmis : la clé est libérée, l'utilisateur
        // peut corriger sa saisie et réessayer.
        await this.prisma.idempotencyKey.delete({ where: { id: keyId } }).catch(() => {});
      } else if (error instanceof BrokerError && error.code === "BROKER_UNAUTHORIZED") {
        await this.fail(orderId, "BROKER_UNAUTHORIZED", error.message);
        await this.prisma.idempotencyKey.delete({ where: { id: keyId } }).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Transmet l'ordre et range son issue. Ne lève que `BROKER_UNAUTHORIZED` :
   * un refus ou une coupure sont des issues normales, rendues en réponse.
   */
  private async transmit(
    context: BrokerContext,
    provider: BrokerProvider,
    orderId: string,
    request: { symbol: string; side: OrderSideName; notional: string; clientOrderId: string },
    market: MarketClock | null
  ): Promise<HttpOutcome> {
    try {
      const placed = await provider.placeNotionalOrder(context, request);
      await this.applyBrokerOrder(orderId, placed, "BROKER");
      return { status: 201, body: { order: await this.dto(orderId), market } };
    } catch (error) {
      if (!(error instanceof BrokerError)) throw error;

      if (error.code === "BROKER_UNAUTHORIZED") throw error;

      if (error.code === "ORDER_REJECTED") {
        await this.transition(orderId, "REJECTED", "BROKER", null, {
          failureCode: "ORDER_REJECTED",
          failureMessage: error.message
        });
        return {
          status: 422,
          body: {
            success: false,
            error: { code: "ORDER_REJECTED", message: error.message },
            order: await this.dto(orderId)
          }
        };
      }

      /*
       * Issue inconnue : coupure, 5xx, limite de débit. L'ordre a pu partir.
       * On le cherche par sa clé ; retrouvé, c'est un succès ordinaire.
       */
      try {
        const found = await provider.findOrderByClientOrderId(context, request.clientOrderId);
        if (found) {
          await this.applyBrokerOrder(orderId, found, "BROKER");
          return { status: 201, body: { order: await this.dto(orderId), market } };
        }
      } catch {
        /* le doute demeure : traité ci-dessous */
      }

      await this.transition(orderId, "SUBMITTED", "AMARA", null, {
        failureCode: PENDING_CONFIRMATION,
        failureMessage: "Transmission interrompue : confirmation du courtier en attente."
      });

      return { status: 202, body: { order: await this.dto(orderId), market } };
    }
  }

  /* ========================================================
   * IDEMPOTENCE
   * ======================================================== */

  private async claimIdempotencyKey(
    userId: string,
    key: string,
    requestHash: string
  ): Promise<{ kind: "claimed"; id: string } | { kind: "replay"; outcome: HttpOutcome }> {
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60 * 1000);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      /*
       * `skipDuplicates` plutôt que capturer l'erreur d'unicité : deux
       * requêtes simultanées sont un cas NORMAL ici, et Prisma journalise
       * chaque violation comme une erreur — un bruit qui ferait croire à une
       * panne. Si la ligne est insérée, c'est la nôtre.
       */
      const inserted = await this.prisma.idempotencyKey.createMany({
        data: [{ key, userId, endpoint: ENDPOINT, requestHash, status: "IN_PROGRESS", expiresAt }],
        skipDuplicates: true
      });

      if (inserted.count === 1) {
        const mine = await this.prisma.idempotencyKey.findUniqueOrThrow({
          where: { userId_key: { userId, key } },
          select: { id: true }
        });
        return { kind: "claimed", id: mine.id };
      }

      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { userId_key: { userId, key } }
      });
      if (!existing) continue; // supprimée entre-temps : on retente la prise

      if (existing.endpoint !== ENDPOINT || existing.requestHash !== requestHash) {
        throw new BrokerError(
          "IDEMPOTENCY_CONFLICT",
          "Cette clé a déjà servi pour un ordre différent.",
          422
        );
      }

      if (existing.resourceId) {
        const stored = existing.responseBody as { status?: number } | null;
        return {
          kind: "replay",
          outcome: {
            status: stored?.status ?? 202,
            body: await this.replayBody(existing.resourceId, existing.responseBody),
            replayed: true
          }
        };
      }

      const abandoned =
        existing.status !== "IN_PROGRESS" ||
        this.now().getTime() - existing.createdAt.getTime() > STALE_IDEMPOTENCY_MS;

      if (!abandoned) {
        throw new BrokerError(
          "IDEMPOTENCY_IN_PROGRESS",
          "Cet ordre est en cours de transmission. Patientez un instant.",
          409
        );
      }

      await this.prisma.idempotencyKey.delete({ where: { id: existing.id } }).catch(() => {});
    }

    throw new BrokerError("IDEMPOTENCY_IN_PROGRESS", "Réessayez dans un instant.", 409);
  }

  private async completeIdempotencyKey(id: string, outcome: HttpOutcome) {
    await this.prisma.idempotencyKey.update({
      where: { id },
      data: {
        status: "COMPLETED",
        // Le statut HTTP d'origine est conservé ; le corps est reconstruit
        // au rejeu, pour refléter l'état COURANT de l'ordre.
        responseBody: { status: outcome.status }
      }
    });
  }

  /** Corps d'un rejeu : même forme qu'à l'origine, ordre à jour. */
  private async replayBody(orderId: string, stored: unknown) {
    const order = await this.dto(orderId);
    const status = (stored as { status?: number } | null)?.status;

    if (status === 422) {
      return {
        success: false,
        error: { code: "ORDER_REJECTED", message: order.failureMessage ?? "Alpaca a refusé l’ordre." },
        order
      };
    }
    return { order, market: null };
  }

  /* ========================================================
   * LECTURE
   * ======================================================== */

  private async dto(orderId: string): Promise<OrderDto> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: ORDER_DTO_SELECT
    });
    return toOrderDto(order);
  }

  async listOrders(
    userId: string,
    options: { environment?: string; limit: number; cursor?: string }
  ): Promise<{ orders: OrderDto[]; nextCursor: string | null }> {
    const environment = options.environment ? this.broker.environmentFor(options.environment) : null;

    const rows = await this.prisma.order.findMany({
      where: {
        userId,
        ...(environment ? { brokerConnection: { environment } } : {})
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: options.limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      select: ORDER_DTO_SELECT
    });

    const page = rows.slice(0, options.limit);
    return {
      orders: page.map(toOrderDto),
      nextCursor: rows.length > options.limit ? page[page.length - 1].id : null
    };
  }

  /**
   * Un ordre de l'utilisateur, rafraîchi auprès du courtier s'il n'est pas
   * terminé. Si le courtier ne répond pas, l'état stocké est rendu tel quel,
   * signalé comme potentiellement périmé.
   */
  async getOrder(userId: string, orderId: string): Promise<{ order: OrderDto; stale: boolean }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, status: true }
    });

    if (!order) {
      throw new BrokerError("ORDER_NOT_FOUND", "Ordre introuvable.", 404);
    }

    if (TERMINAL_STATUSES.has(order.status)) {
      return { order: await this.dto(order.id), stale: false };
    }

    try {
      await this.syncOrder(order.id);
      return { order: await this.dto(order.id), stale: false };
    } catch {
      return { order: await this.dto(order.id), stale: true };
    }
  }

  /* ========================================================
   * SYNCHRONISATION
   * ======================================================== */

  /** Relit un ordre chez le courtier et applique ce qu'il rapporte. */
  async syncOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        status: true,
        clientOrderId: true,
        brokerOrderId: true,
        createdAt: true,
        brokerConnection: { select: { environment: true } }
      }
    });

    if (TERMINAL_STATUSES.has(order.status) || !order.brokerConnection) return;

    await this.broker.withBroker(
      order.userId,
      order.brokerConnection.environment,
      async (context, { provider }) => {
        const reported = order.brokerOrderId
          ? await provider.getOrder(context, order.brokerOrderId)
          : await provider.findOrderByClientOrderId(context, order.clientOrderId);

        if (reported) {
          await this.applyBrokerOrder(order.id, reported, "WORKER");
          return;
        }

        const age = this.now().getTime() - order.createdAt.getTime();
        if (!order.brokerOrderId && age > NOT_RECEIVED_AFTER_MS) {
          await this.transition(order.id, "FAILED", "WORKER", null, {
            failureCode: "NOT_RECEIVED_BY_BROKER",
            failureMessage: "Le courtier n’a jamais reçu cet ordre. Aucun montant n’a été investi."
          });
          return;
        }

        await this.prisma.order.update({
          where: { id: order.id },
          data: { lastSyncedAt: this.now() }
        });
      }
    );
  }

  /**
   * Synchronise les ordres en cours, pour le worker.
   *
   * Cadence adaptée à l'âge : un ordre récent est relu à chaque passage, un
   * ordre en file depuis longtemps (marché fermé la nuit) toutes les deux
   * minutes — inutile d'interroger le courtier toutes les quinze secondes
   * pour un ordre qui attend l'ouverture.
   */
  async syncPending(limit = 50): Promise<{ checked: number; failed: number }> {
    const now = this.now().getTime();

    const candidates = await this.prisma.order.findMany({
      where: {
        status: { in: NON_TERMINAL_STATUSES },
        brokerConnection: { status: "CONNECTED" },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now - 5_000) } }]
      },
      orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
      take: limit * 2,
      select: { id: true, createdAt: true, lastSyncedAt: true }
    });

    const due = candidates
      .filter((o) => {
        const young = now - o.createdAt.getTime() < 5 * 60 * 1000;
        const since = o.lastSyncedAt ? now - o.lastSyncedAt.getTime() : Infinity;
        return young || since > 120_000;
      })
      .slice(0, limit);

    let failed = 0;
    for (const order of due) {
      try {
        await this.syncOrder(order.id);
      } catch {
        failed += 1;
      }
    }

    return { checked: due.length, failed };
  }

  /* ========================================================
   * ÉCRITURES D'ÉTAT
   * ======================================================== */

  /** Applique un ordre rapporté par le courtier : exécution, dates, statut. */
  private async applyBrokerOrder(
    orderId: string,
    reported: BrokerOrder,
    source: "BROKER" | "WORKER"
  ): Promise<void> {
    const current = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, failureCode: true }
    });

    const date = (value: string | null) => (value ? new Date(value) : undefined);

    // L'exécution est toujours prise : elle ne recule pas, même si le statut
    // rapporté est inconnu.
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        brokerOrderId: reported.externalId,
        filledQuantity: reported.filledQuantity,
        averageFilledPrice: reported.averageFilledPrice ?? undefined,
        submittedAt: date(reported.submittedAt),
        filledAt: date(reported.filledAt),
        cancelledAt: date(reported.cancelledAt),
        expiresAt: date(reported.expiredAt),
        lastSyncedAt: this.now(),
        // Le doute est levé : l'ordre est bien chez le courtier.
        ...(current.failureCode === PENDING_CONFIRMATION
          ? { failureCode: null, failureMessage: null }
          : {})
      }
    });

    if (reported.status === null) {
      await this.reconcile(orderId, current.status, reported.rawStatus, "Statut du courtier inconnu");
      return;
    }

    const decision = decideTransition(current.status, reported.status);

    if (decision.apply) {
      await this.transition(orderId, reported.status, source, reported.rawStatus, {
        ...(reported.status === "REJECTED"
          ? { failureCode: "ORDER_REJECTED", failureMessage: "Alpaca a refusé l’ordre." }
          : {}),
        ...(reported.status !== "FAILED" && current.status === "FAILED"
          ? { failureCode: null, failureMessage: null }
          : {})
      });
    } else if (decision.anomaly) {
      await this.reconcile(orderId, current.status, reported.rawStatus, "Transition refusée");
    }
  }

  private async transition(
    orderId: string,
    to: OrderStatusName,
    source: "AMARA" | "BROKER" | "WORKER",
    brokerStatusRaw: string | null,
    extra: { failureCode?: string | null; failureMessage?: string | null } = {}
  ): Promise<void> {
    const current = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true }
    });

    /*
     * Écriture conditionnelle au statut lu. Le worker et une lecture
     * `GET /orders/:id` peuvent synchroniser le même ordre au même instant :
     * sans cette condition, les deux écriraient l'événement de transition.
     * Le perdant voit `count === 0` et s'abstient.
     */
    const updated = await this.prisma.order.updateMany({
      where: { id: orderId, status: current.status },
      data: { status: to, lastSyncedAt: this.now(), ...extra }
    });

    if (updated.count === 1 && current.status !== to) {
      await this.prisma.orderEvent.create({
        data: { orderId, fromStatus: current.status, toStatus: to, source, brokerStatusRaw }
      });
    }
  }

  private async fail(orderId: string, code: string, message: string) {
    await this.transition(orderId, "FAILED", "AMARA", null, {
      failureCode: code,
      failureMessage: message
    });
  }

  /** Trace un écart sans jamais le « corriger » à l'aveugle. Sans doublon. */
  private async reconcile(orderId: string, status: OrderStatusName, rawStatus: string, note: string) {
    const open = await this.prisma.reconciliationLog.findFirst({
      where: { scope: "ORDER", entityId: orderId, status: "OPEN", note },
      select: { id: true }
    });
    if (open) return;

    console.warn(`[orders] réconciliation ouverte : ${note} (${rawStatus})`);
    await this.prisma.reconciliationLog.create({
      data: {
        scope: "ORDER",
        entityType: "Order",
        entityId: orderId,
        expected: { status },
        actual: { brokerStatus: rawStatus },
        note
      }
    });
  }

  private async portfolioFor(userId: string): Promise<string> {
    const existing = await this.prisma.portofolios.findFirst({
      where: { user_id: userId },
      orderBy: { created_at: "asc" },
      select: { id: true }
    });
    if (existing) return existing.id;

    const created = await this.prisma.portofolios.create({
      data: { user_id: userId },
      select: { id: true }
    });
    return created.id;
  }
}
