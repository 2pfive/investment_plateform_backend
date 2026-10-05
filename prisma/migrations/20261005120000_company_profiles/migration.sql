-- Fiches d'entreprise (Wikidata / Wikipédia), en cache par symbole.
CREATE TABLE "market_data"."company_profiles" (
    "symbol" VARCHAR(32) NOT NULL,
    "wikidata_id" VARCHAR(32),
    "name" TEXT,
    "logo_url" TEXT,
    "industry" TEXT,
    "employees" INTEGER,
    "headquarters" TEXT,
    "ipo_date" VARCHAR(10),
    "website" TEXT,
    "wiki_title_fr" TEXT,
    "summary_fr" TEXT,
    "summary_en" TEXT,
    "description_fr" TEXT,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_profiles_pkey" PRIMARY KEY ("symbol")
);
