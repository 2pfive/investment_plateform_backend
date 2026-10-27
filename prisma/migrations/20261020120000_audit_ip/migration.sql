-- Journal d'audit : adresse IP, navigateur, connexions (admins et clients).
ALTER TABLE "auth"."admin_audit_logs" ALTER COLUMN "admin_id" DROP NOT NULL;
ALTER TABLE "auth"."admin_audit_logs" ADD COLUMN "actor_email" VARCHAR(255);
ALTER TABLE "auth"."admin_audit_logs" ADD COLUMN "ip" VARCHAR(64);
ALTER TABLE "auth"."admin_audit_logs" ADD COLUMN "user_agent" VARCHAR(512);
CREATE INDEX "idx_admin_audit_action" ON "auth"."admin_audit_logs"("action");
