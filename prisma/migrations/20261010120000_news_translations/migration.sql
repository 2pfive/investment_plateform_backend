-- Titres d'actualités traduits en français (DeepL), en cache par article.
CREATE TABLE "market_data"."news_translations" (
    "article_id" VARCHAR(32) NOT NULL,
    "headline" TEXT NOT NULL,
    "headline_fr" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_translations_pkey" PRIMARY KEY ("article_id")
);
