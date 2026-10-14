-- Mode pilote choisi par l'utilisateur ; NULL = choix du serveur.
ALTER TABLE "auth"."user" ADD COLUMN "trading_mode" "investing"."BrokerEnvironment";

-- Ledger du compte partagé : mouvements d'espèces par utilisateur et par mode.
CREATE TABLE "billing"."cash_movements" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "environment" "investing"."BrokerEnvironment" NOT NULL,
    "amount_usd" DECIMAL(24,8) NOT NULL,
    "amount" DECIMAL(24,8) NOT NULL,
    "currency" "billing"."Currency" NOT NULL,
    "fx_rate" DECIMAL(24,12) NOT NULL,
    "note" TEXT NOT NULL,
    "created_by" VARCHAR(100) NOT NULL,
    "reference" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cash_movements_reference_key" ON "billing"."cash_movements"("reference");
CREATE INDEX "idx_cash_movements_user_env" ON "billing"."cash_movements"("user_id", "environment");

ALTER TABLE "billing"."cash_movements" ADD CONSTRAINT "fk_cash_movements_user" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
