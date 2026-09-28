-- =============================================================================
-- AMARA Phase 2 — étape 1/2 : valeurs d'enum
--
-- Isolé dans sa propre migration à dessein.
--
-- `ALTER TYPE ... ADD VALUE` ne peut pas s'exécuter dans un bloc transactionnel
-- sur PostgreSQL <= 11, et sur PostgreSQL >= 12 la nouvelle valeur n'est pas
-- utilisable dans la même transaction que son ajout. Prisma exécute chaque
-- fichier migration.sql dans UNE transaction : séparer ces trois instructions
-- du reste garantit qu'aucune des deux limitations ne se déclenche.
--
-- Purement additif : aucune valeur existante n'est renommée ni retirée.
-- =============================================================================

ALTER TYPE "billing"."transaction_type" ADD VALUE IF NOT EXISTS 'fee';
ALTER TYPE "billing"."transaction_type" ADD VALUE IF NOT EXISTS 'dividend';
ALTER TYPE "billing"."transaction_type" ADD VALUE IF NOT EXISTS 'adjustment';
