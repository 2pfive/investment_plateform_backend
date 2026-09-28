-- =============================================================================
-- AMARA Phase 2 — étape 2/2 : refonte additive
--
-- Généré par `prisma migrate diff`, puis complété par les deux contrôles
-- bloquants ci-dessous. Ne pas éditer à la main sans régénérer le diff.
--
-- Garanties de cette migration :
--   * aucune table supprimée, aucune colonne supprimée ni renommée ;
--   * toutes les colonnes ajoutées sont NULLABLE ou pourvues d'un DEFAULT ;
--   * les seules modifications de type sont des ÉLARGISSEMENTS de précision
--     Decimal, non destructifs en PostgreSQL ;
--   * le backend web actuel continue de fonctionner sans changement de code
--     (vérifié : `tsc --noEmit` ne remonte aucune erreur liée à Prisma).
--
-- Deux instructions dépendent en revanche de la propreté des données et sont
-- précédées d'un contrôle explicite. Elles échouent avec un message clair
-- plutôt qu'avec une erreur de contrainte illisible :
--   1. l'index unique (portofolio_id, etf_id) sur positions ;
--   2. la clé étrangère de portofolio_snapshots vers portofolios.
--
-- Rien n'est corrigé automatiquement : c'est de la donnée financière, la
-- déduplication et la purge relèvent d'une décision, pas d'un script.
-- Lancer prisma/preflight-phase2.sql pour le diagnostic détaillé.
--
-- Les valeurs d'enum ajoutées à transaction_type vivent dans la migration
-- 20260831120000_phase2_enum_values, exécutée juste avant : ALTER TYPE ...
-- ADD VALUE ne supporte pas d'être groupé dans la même transaction.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- PRÉ-VOL 1 — doublons de position
--
-- Le code actuel fait findFirst + create sans contrainte d'unicité : deux
-- investissements concurrents sur le même actif créent deux lignes.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_dup integer;
BEGIN
  SELECT count(*) INTO v_dup
  FROM (
    SELECT portofolio_id, etf_id
    FROM "investing"."positions"
    GROUP BY portofolio_id, etf_id
    HAVING count(*) > 1
  ) d;

  IF v_dup > 0 THEN
    RAISE EXCEPTION
      'Migration interrompue : % couple(s) (portofolio_id, etf_id) en doublon dans investing.positions. Fusionner ces positions avant de rejouer la migration — voir prisma/preflight-phase2.sql.', v_dup;
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- PRÉ-VOL 2 — snapshots orphelins
--
-- portofolio_snapshots.portofolio_id n'a jamais eu de clé étrangère : la
-- colonne peut contenir des UUID ne correspondant à aucun portefeuille.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_orphans integer;
BEGIN
  SELECT count(*) INTO v_orphans
  FROM "investing"."portofolio_snapshots" s
  WHERE NOT EXISTS (
    SELECT 1 FROM "investing"."portofolios" p WHERE p.id = s.portofolio_id
  );

  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      'Migration interrompue : % snapshot(s) orphelin(s) dans investing.portofolio_snapshots. Purger ou réaffecter ces lignes avant de rejouer la migration — voir prisma/preflight-phase2.sql.', v_orphans;
  END IF;
END $$;


-- CreateEnum
CREATE TYPE "auth"."KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "billing"."TransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "billing"."Currency" AS ENUM ('XAF', 'USD', 'EUR');

-- CreateEnum
CREATE TYPE "investing"."OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "investing"."OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "investing"."TimeInForce" AS ENUM ('DAY', 'GTC');

-- CreateEnum
CREATE TYPE "investing"."OrderStatus" AS ENUM ('CREATED', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "investing"."OrderEventSource" AS ENUM ('AMARA', 'BROKER', 'WORKER');

-- CreateEnum
CREATE TYPE "investing"."BrokerProviderKind" AS ENUM ('ALPACA_OAUTH', 'ALPACA_BROKER', 'MOCK');

-- CreateEnum
CREATE TYPE "investing"."BrokerEnvironment" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "investing"."BrokerConnectionStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTING', 'CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "investing"."IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "investing"."ReconciliationScope" AS ENUM ('ORDER', 'POSITION', 'ACCOUNT', 'PORTFOLIO');

-- CreateEnum
CREATE TYPE "investing"."ReconciliationStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "market_data"."AssetType" AS ENUM ('STOCK', 'ETF');

-- CreateEnum
CREATE TYPE "market_data"."AssetStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DELISTED');

-- CreateEnum
CREATE TYPE "market_data"."MarketDataSource" AS ENUM ('YAHOO', 'ALPACA', 'MANUAL');

-- CreateEnum
CREATE TYPE "market_data"."PriceInterval" AS ENUM ('MIN_1', 'MIN_5', 'HOUR_1', 'DAY_1');


-- AlterTable
ALTER TABLE "auth"."user" ADD COLUMN     "country" VARCHAR(2),
ADD COLUMN     "kyc_status" "auth"."KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "billing"."accounts" ADD COLUMN     "reserved_balance" DECIMAL(24,8) NOT NULL DEFAULT 0,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6),
ALTER COLUMN "balance" SET DATA TYPE DECIMAL(24,8);

-- AlterTable
ALTER TABLE "billing"."transactions" ADD COLUMN     "currency" "billing"."Currency" NOT NULL DEFAULT 'XAF',
ADD COLUMN     "external_reference" VARCHAR(128),
ADD COLUMN     "fee" DECIMAL(24,8) NOT NULL DEFAULT 0,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "order_id" UUID,
ADD COLUMN     "reference" VARCHAR(64),
ADD COLUMN     "status" "billing"."TransactionStatus" NOT NULL DEFAULT 'COMPLETED',
ADD COLUMN     "updated_at" TIMESTAMPTZ(6),
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(24,8);

-- AlterTable
ALTER TABLE "investing"."portofolios" ADD COLUMN     "base_currency" "billing"."Currency" NOT NULL DEFAULT 'XAF',
ADD COLUMN     "total_value" DECIMAL(24,8),
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "investing"."positions" ADD COLUMN     "asset_id" UUID,
ADD COLUMN     "broker_quantity" DECIMAL(24,9),
ADD COLUMN     "currency" "billing"."Currency" NOT NULL DEFAULT 'USD',
ADD COLUMN     "current_price" DECIMAL(24,8),
ADD COLUMN     "last_synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "market_value" DECIMAL(24,8),
ADD COLUMN     "realized_pnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
ADD COLUMN     "unrealized_pnl" DECIMAL(24,8),
ADD COLUMN     "updated_at" TIMESTAMPTZ(6),
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(24,9),
ALTER COLUMN "avg_buy_price" SET DATA TYPE DECIMAL(24,8);

-- AlterTable
ALTER TABLE "market_data"."prices" ALTER COLUMN "price" SET DATA TYPE DECIMAL(24,8);

-- AlterTable
ALTER TABLE "investing"."portofolio_snapshots" ADD COLUMN     "cash_balance" DECIMAL(24,8),
ADD COLUMN     "currency" "billing"."Currency" NOT NULL DEFAULT 'XAF',
ALTER COLUMN "portofolio_value" SET DATA TYPE DECIMAL(24,8),
ALTER COLUMN "invested_amount" SET DATA TYPE DECIMAL(24,8);

-- AlterTable
ALTER TABLE "market_data"."etf_dividend" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(24,8);

-- AlterTable
ALTER TABLE "market_data"."etf_holding" ALTER COLUMN "weight" SET DATA TYPE DECIMAL(9,6);

-- CreateTable
CREATE TABLE "investing"."orders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "broker_connection_id" UUID,
    "side" "investing"."OrderSide" NOT NULL,
    "order_type" "investing"."OrderType" NOT NULL DEFAULT 'MARKET',
    "time_in_force" "investing"."TimeInForce" NOT NULL DEFAULT 'DAY',
    "status" "investing"."OrderStatus" NOT NULL DEFAULT 'CREATED',
    "requested_amount" DECIMAL(24,8) NOT NULL,
    "requested_currency" "billing"."Currency" NOT NULL,
    "notional" DECIMAL(24,8),
    "trading_currency" "billing"."Currency" NOT NULL DEFAULT 'USD',
    "quantity" DECIMAL(24,9),
    "limit_price" DECIMAL(24,8),
    "stop_price" DECIMAL(24,8),
    "fx_rate" DECIMAL(24,12),
    "fx_rate_id" UUID,
    "fee" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "client_order_id" VARCHAR(128) NOT NULL,
    "broker_order_id" VARCHAR(128),
    "filled_quantity" DECIMAL(24,9) NOT NULL DEFAULT 0,
    "average_filled_price" DECIMAL(24,8),
    "submitted_at" TIMESTAMPTZ(6),
    "filled_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "failure_code" VARCHAR(64),
    "failure_message" TEXT,
    "last_synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investing"."order_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "investing"."OrderStatus",
    "to_status" "investing"."OrderStatus" NOT NULL,
    "source" "investing"."OrderEventSource" NOT NULL DEFAULT 'AMARA',
    "broker_status_raw" VARCHAR(64),
    "payload" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investing"."broker_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "investing"."BrokerProviderKind" NOT NULL DEFAULT 'ALPACA_OAUTH',
    "environment" "investing"."BrokerEnvironment" NOT NULL DEFAULT 'PAPER',
    "status" "investing"."BrokerConnectionStatus" NOT NULL DEFAULT 'CONNECTING',
    "external_account_id" VARCHAR(128),
    "account_last4" VARCHAR(8),
    "currency" "billing"."Currency" NOT NULL DEFAULT 'USD',
    "access_token_ciphertext" TEXT,
    "encryption_key_id" VARCHAR(32),
    "access_token_fingerprint" VARCHAR(64),
    "scope" VARCHAR(255),
    "refresh_token_ciphertext" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "connected_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_error_at" TIMESTAMPTZ(6),
    "last_error_msg" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "broker_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investing"."oauth_states" (
    "id" UUID NOT NULL,
    "state" VARCHAR(128) NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "investing"."BrokerProviderKind" NOT NULL DEFAULT 'ALPACA_OAUTH',
    "environment" "investing"."BrokerEnvironment" NOT NULL DEFAULT 'PAPER',
    "redirect_uri" VARCHAR(512) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investing"."idempotency_keys" (
    "id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" "investing"."IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "resource_type" VARCHAR(64),
    "resource_id" UUID,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investing"."reconciliation_logs" (
    "id" UUID NOT NULL,
    "scope" "investing"."ReconciliationScope" NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(128),
    "expected" JSONB,
    "actual" JSONB,
    "note" TEXT,
    "status" "investing"."ReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "reconciliation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data"."assets" (
    "id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "name" TEXT NOT NULL,
    "asset_type" "market_data"."AssetType" NOT NULL,
    "exchange" VARCHAR(32),
    "currency" "billing"."Currency" NOT NULL DEFAULT 'USD',
    "isin" VARCHAR(20),
    "status" "market_data"."AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "tradable" BOOLEAN NOT NULL DEFAULT false,
    "fractionable" BOOLEAN NOT NULL DEFAULT false,
    "shortable" BOOLEAN NOT NULL DEFAULT false,
    "logo_url" TEXT,
    "description" TEXT,
    "broker_asset_id" VARCHAR(128),
    "legacy_etf_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data"."etf_metadata" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "expense_ratio" DECIMAL(9,6),
    "dividend_yield" DECIMAL(9,6),
    "fund_family" VARCHAR(100),
    "category" VARCHAR(100),
    "region" VARCHAR(100),
    "sector" VARCHAR(100),
    "asset_class" VARCHAR(50),
    "risk_level" VARCHAR(50),
    "distribution_policy" VARCHAR(10),
    "distribution_frequency" VARCHAR(20),
    "inception_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "etf_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data"."market_prices" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "interval" "market_data"."PriceInterval" NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "open" DECIMAL(24,8),
    "high" DECIMAL(24,8),
    "low" DECIMAL(24,8),
    "close" DECIMAL(24,8) NOT NULL,
    "volume" BIGINT,
    "source" "market_data"."MarketDataSource" NOT NULL DEFAULT 'YAHOO',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data"."fx_rates" (
    "id" UUID NOT NULL,
    "base" "billing"."Currency" NOT NULL,
    "quote" "billing"."Currency" NOT NULL,
    "rate" DECIMAL(24,12) NOT NULL,
    "source" VARCHAR(64) NOT NULL DEFAULT 'exchangerate-api',
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_client_order_id_key" ON "investing"."orders"("client_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_broker_order_id_key" ON "investing"."orders"("broker_order_id");

-- CreateIndex
CREATE INDEX "idx_orders_user_created" ON "investing"."orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_orders_status" ON "investing"."orders"("status");

-- CreateIndex
CREATE INDEX "idx_orders_portfolio" ON "investing"."orders"("portfolio_id");

-- CreateIndex
CREATE INDEX "idx_orders_asset" ON "investing"."orders"("asset_id");

-- CreateIndex
CREATE INDEX "idx_order_events_order_occurred" ON "investing"."order_events"("order_id", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_broker_connections_status" ON "investing"."broker_connections"("status");

-- CreateIndex
CREATE INDEX "idx_broker_connections_external_account" ON "investing"."broker_connections"("external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_broker_connections_user_provider_env" ON "investing"."broker_connections"("user_id", "provider", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_key" ON "investing"."oauth_states"("state");

-- CreateIndex
CREATE INDEX "idx_oauth_states_user" ON "investing"."oauth_states"("user_id");

-- CreateIndex
CREATE INDEX "idx_oauth_states_expires" ON "investing"."oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "idx_idempotency_keys_expires" ON "investing"."idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_idempotency_keys_user_key" ON "investing"."idempotency_keys"("user_id", "key");

-- CreateIndex
CREATE INDEX "idx_reconciliation_logs_scope_status" ON "investing"."reconciliation_logs"("scope", "status");

-- CreateIndex
CREATE INDEX "idx_reconciliation_logs_detected" ON "investing"."reconciliation_logs"("detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "assets_symbol_key" ON "market_data"."assets"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "assets_legacy_etf_id_key" ON "market_data"."assets"("legacy_etf_id");

-- CreateIndex
CREATE INDEX "idx_assets_type_status" ON "market_data"."assets"("asset_type", "status");

-- CreateIndex
CREATE INDEX "idx_assets_tradable" ON "market_data"."assets"("tradable");

-- CreateIndex
CREATE UNIQUE INDEX "etf_metadata_asset_id_key" ON "market_data"."etf_metadata"("asset_id");

-- CreateIndex
CREATE INDEX "idx_market_prices_lookup" ON "market_data"."market_prices"("asset_id", "interval", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_market_prices_asset_interval_ts" ON "market_data"."market_prices"("asset_id", "interval", "timestamp");

-- CreateIndex
CREATE INDEX "idx_fx_rates_pair_fetched" ON "market_data"."fx_rates"("base", "quote", "fetched_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reference_key" ON "billing"."transactions"("reference");

-- CreateIndex
CREATE INDEX "idx_transactions_order_id" ON "billing"."transactions"("order_id");

-- CreateIndex
CREATE INDEX "idx_transactions_external_reference" ON "billing"."transactions"("external_reference");

-- CreateIndex
CREATE INDEX "idx_positions_asset_id" ON "investing"."positions"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_positions_portofolio_etf" ON "investing"."positions"("portofolio_id", "etf_id");

-- CreateIndex
CREATE INDEX "idx_portofolio_snapshots_portofolio_recorded" ON "investing"."portofolio_snapshots"("portofolio_id", "recorded_at");

-- CreateIndex
CREATE INDEX "idx_etf_dividend_etf_pay_date" ON "market_data"."etf_dividend"("etf_id", "pay_date");

-- CreateIndex
CREATE INDEX "idx_etf_holding_etf_id" ON "market_data"."etf_holding"("etf_id");

-- AddForeignKey
ALTER TABLE "billing"."transactions" ADD CONSTRAINT "fk_transactions_order" FOREIGN KEY ("order_id") REFERENCES "investing"."orders"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."positions" ADD CONSTRAINT "fk_positions_asset" FOREIGN KEY ("asset_id") REFERENCES "market_data"."assets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."portofolio_snapshots" ADD CONSTRAINT "fk_portofolio_snapshots_portofolio" FOREIGN KEY ("portofolio_id") REFERENCES "investing"."portofolios"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."orders" ADD CONSTRAINT "fk_orders_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."orders" ADD CONSTRAINT "fk_orders_portfolio" FOREIGN KEY ("portfolio_id") REFERENCES "investing"."portofolios"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."orders" ADD CONSTRAINT "fk_orders_asset" FOREIGN KEY ("asset_id") REFERENCES "market_data"."assets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."orders" ADD CONSTRAINT "fk_orders_broker_connection" FOREIGN KEY ("broker_connection_id") REFERENCES "investing"."broker_connections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."orders" ADD CONSTRAINT "fk_orders_fx_rate" FOREIGN KEY ("fx_rate_id") REFERENCES "market_data"."fx_rates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."order_events" ADD CONSTRAINT "fk_order_events_order" FOREIGN KEY ("order_id") REFERENCES "investing"."orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."broker_connections" ADD CONSTRAINT "fk_broker_connections_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."oauth_states" ADD CONSTRAINT "fk_oauth_states_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."idempotency_keys" ADD CONSTRAINT "fk_idempotency_keys_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_data"."assets" ADD CONSTRAINT "fk_assets_legacy_etf" FOREIGN KEY ("legacy_etf_id") REFERENCES "market_data"."exchange_traded_fund"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_data"."etf_metadata" ADD CONSTRAINT "fk_etf_metadata_asset" FOREIGN KEY ("asset_id") REFERENCES "market_data"."assets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_data"."market_prices" ADD CONSTRAINT "fk_market_prices_asset" FOREIGN KEY ("asset_id") REFERENCES "market_data"."assets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
