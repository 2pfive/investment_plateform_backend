-- Back-office : comptes équipe, rôles (RBAC) et journal d'audit.
CREATE TYPE "auth"."AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPORT');

CREATE TABLE "auth"."admin_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "password" TEXT NOT NULL,
    "role" "auth"."AdminRole" NOT NULL DEFAULT 'SUPPORT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admin_users_email_key" ON "auth"."admin_users"("email");

CREATE TABLE "auth"."admin_audit_logs" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "target_id" VARCHAR(64),
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_admin_audit_created" ON "auth"."admin_audit_logs"("created_at");

ALTER TABLE "auth"."admin_audit_logs" ADD CONSTRAINT "fk_admin_audit_admin" FOREIGN KEY ("admin_id") REFERENCES "auth"."admin_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
