-- Résumés d'actualités traduits, à côté des titres.
ALTER TABLE "market_data"."news_translations" ADD COLUMN "summary" TEXT,
ADD COLUMN "summary_fr" TEXT;
