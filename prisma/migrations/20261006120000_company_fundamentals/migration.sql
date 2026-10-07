-- Comptes résumés des sociétés (SEC EDGAR), en cache par symbole.
CREATE TABLE "market_data"."company_fundamentals" (
    "symbol" VARCHAR(32) NOT NULL,
    "cik" INTEGER,
    "data" JSONB,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_fundamentals_pkey" PRIMARY KEY ("symbol")
);
