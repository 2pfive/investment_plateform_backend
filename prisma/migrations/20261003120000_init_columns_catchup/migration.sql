-- Rattrapage : colonnes de 0_init absentes des bases antérieures à cette
-- baseline (0_init y a été marquée appliquée sans être exécutée).
-- Idempotente : sans effet là où 0_init a réellement tourné.
ALTER TABLE "auth"."user" ADD COLUMN IF NOT EXISTS "first_name" VARCHAR(100);
ALTER TABLE "auth"."user" ADD COLUMN IF NOT EXISTS "last_name" VARCHAR(100);
ALTER TABLE "billing"."transactions" ADD COLUMN IF NOT EXISTS "asset_id" UUID;
ALTER TABLE "billing"."transactions" ADD COLUMN IF NOT EXISTS "asset_type" VARCHAR(50);
