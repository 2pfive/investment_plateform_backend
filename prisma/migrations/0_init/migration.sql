-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "billing";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "investing";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "market_data";

-- CreateEnum
CREATE TYPE "billing"."transaction_type" AS ENUM ('buy', 'sell', 'deposit', 'withdraw');

-- CreateTable
CREATE TABLE "auth"."user" (
    "_id" SERIAL NOT NULL,
    "user_id" UUID DEFAULT gen_random_uuid(),
    "phone_number" VARCHAR(15) NOT NULL,
    "birth_date" DATE NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6),
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),

    CONSTRAINT "user_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "billing"."accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "balance" DECIMAL(12,4) DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "currency" VARCHAR(8) DEFAULT 'XAF',

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "type" "billing"."transaction_type" DEFAULT 'buy',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "asset_type" VARCHAR(50),
    "asset_id" UUID,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investing"."portofolios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portofolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investing"."positions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "portofolio_id" UUID NOT NULL,
    "etf_id" UUID NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "avg_buy_price" DECIMAL(12,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data"."exchange_traded_fund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "symbol" VARCHAR(50) NOT NULL,
    "name" TEXT NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "category" VARCHAR(100),
    "region" VARCHAR(100),
    "risk_level" VARCHAR(50),
    "expense_ratio" DECIMAL(6,4),
    "inception_date" DATE,
    "dividend_yield" DECIMAL(5,4),
    "isin" VARCHAR(20),
    "description" TEXT,
    "provider" VARCHAR(100),
    "type" VARCHAR(10) NOT NULL DEFAULT 'ACC',
    "asset_class" VARCHAR(50),
    "sector" VARCHAR(100),
    "distribution_frequency" VARCHAR(20),

    CONSTRAINT "exchange_traded_fund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data"."prices" (
    "etf_id" UUID NOT NULL,
    "price" DECIMAL(12,4) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prices_pkey" PRIMARY KEY ("etf_id","recorded_at")
);

-- CreateTable
CREATE TABLE "investing"."portofolio_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "portofolio_id" UUID NOT NULL,
    "portofolio_value" DECIMAL(18,2) NOT NULL,
    "invested_amount" DECIMAL(18,2),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portofolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data"."etf_dividend" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "etf_id" UUID NOT NULL,
    "amount" DECIMAL(10,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "pay_date" DATE NOT NULL,

    CONSTRAINT "etf_dividend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data"."etf_holding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "etf_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "symbol" VARCHAR(20),
    "weight" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "etf_holding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_user_id_key" ON "auth"."user"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "auth"."user"("email");

-- CreateIndex
CREATE INDEX "idx_accounts_user_id" ON "billing"."accounts"("user_id");

-- CreateIndex
CREATE INDEX "idx_transactions_account_id" ON "billing"."transactions"("account_id");

-- CreateIndex
CREATE INDEX "idx_portofolios_user_id" ON "investing"."portofolios"("user_id");

-- CreateIndex
CREATE INDEX "idx_positions_etf_id" ON "investing"."positions"("etf_id");

-- CreateIndex
CREATE INDEX "idx_positions_portofolio_id" ON "investing"."positions"("portofolio_id");

-- CreateIndex
CREATE INDEX "idx_prices_recorded_at" ON "market_data"."prices"("recorded_at");

-- AddForeignKey
ALTER TABLE "billing"."accounts" ADD CONSTRAINT "fk_accounts_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "billing"."transactions" ADD CONSTRAINT "fk_transactions_account" FOREIGN KEY ("account_id") REFERENCES "billing"."accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."portofolios" ADD CONSTRAINT "fk_portofolios_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."positions" ADD CONSTRAINT "fk_positions_etf" FOREIGN KEY ("etf_id") REFERENCES "market_data"."exchange_traded_fund"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."positions" ADD CONSTRAINT "fk_positions_portofolio" FOREIGN KEY ("portofolio_id") REFERENCES "investing"."portofolios"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_data"."prices" ADD CONSTRAINT "fk_prices_etf" FOREIGN KEY ("etf_id") REFERENCES "market_data"."exchange_traded_fund"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_data"."etf_dividend" ADD CONSTRAINT "fk_etf_div" FOREIGN KEY ("etf_id") REFERENCES "market_data"."exchange_traded_fund"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_data"."etf_holding" ADD CONSTRAINT "fk_etf" FOREIGN KEY ("etf_id") REFERENCES "market_data"."exchange_traded_fund"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

