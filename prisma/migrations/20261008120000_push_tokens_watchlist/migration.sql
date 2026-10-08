-- Jetons Expo Push des appareils, et actifs suivis par les utilisateurs.
-- CreateTable
CREATE TABLE "auth"."push_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investing"."watchlist_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_token_key" ON "auth"."push_tokens"("token");

-- CreateIndex
CREATE INDEX "idx_push_tokens_user" ON "auth"."push_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_watchlist_items_user_symbol" ON "investing"."watchlist_items"("user_id", "symbol");

-- AddForeignKey
ALTER TABLE "auth"."push_tokens" ADD CONSTRAINT "fk_push_tokens_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "investing"."watchlist_items" ADD CONSTRAINT "fk_watchlist_items_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

