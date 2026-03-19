-- SCHEMA: investing

-- DROP SCHEMA IF EXISTS investing ;

SET SEARCH_PATH="investing";

CREATE TABLE "portofolios"(
	"id" UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
	"user_id" UUID REFERENCES auth.user("user_id"),
	"created_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE "positions"(
	"id" UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
	"portofolio_id" UUID REFERENCES "portofolios"("id"),
	"etf_id" UUID REFERENCES market_data.exchange_traded_fund("id"),
	"quantity" NUMERIC(12,4) NOT NULL,
	"avg_buy_price" NUMERIC(12,4) NOT NULL,
	"created_at" TIMESTAMPTZ DEFAULT NOW()
)