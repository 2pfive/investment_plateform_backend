SET SEARCH_PATH="market_data";

DROP TABLE IF EXISTS "exchange_traded_fund";
CREATE TABLE "exchange_traded_fund"(
	"id" UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
	"symbol" VARCHAR(50) NOT NULL,
	"name" TEXT NOT NULL,
	"currency" VARCHAR(10) NOT NULL 
);

CREATE TABLE market_data.prices(
	etf_id UUID REFERENCES market_data.exchange_traded_fund("id"),
	price NUMERIC(12,4) NOT NULL,
	recorded_at TIMESTAMPTZ DEFAULT NOW(),
	PRIMARY KEY(etf_id,recorded_at)
);