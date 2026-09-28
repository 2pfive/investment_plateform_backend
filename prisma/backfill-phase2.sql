-- =============================================================================
-- AMARA Phase 2 — backfill des nouvelles tables
--
-- À lancer APRÈS `prisma migrate deploy`, dans une transaction.
--
--   psql "$DATABASE_URL" -f prisma/backfill-phase2.sql
--
-- Ce que fait ce script :
--   1. crée une ligne market_data.assets pour chaque exchange_traded_fund ;
--   2. déporte les colonnes spécifiques ETF dans market_data.etf_metadata ;
--   3. renseigne investing.positions.asset_id ;
--   4. déclare le compte broker partagé (Alpaca Trading = structure omnibus).
--
-- IDEMPOTENT : rejouable sans créer de doublon (ON CONFLICT DO NOTHING /
-- clauses WHERE ... IS NULL). Le worker de synchro broker viendra ensuite
-- renseigner tradable, fractionable, exchange et broker_asset_id, qui restent
-- volontairement à leur valeur par défaut ici : ces informations viennent
-- d'Alpaca, pas de la base historique. Tant qu'elles ne sont pas synchronisées,
-- tradable = false et aucun ordre ne peut partir — c'est le comportement voulu.
--
-- Rien n'est supprimé : exchange_traded_fund reste la source du frontend web.
-- =============================================================================

BEGIN;


-- -----------------------------------------------------------------------------
-- 1. exchange_traded_fund -> assets
-- -----------------------------------------------------------------------------
INSERT INTO "market_data"."assets" (
  id, symbol, name, asset_type, currency, isin, status,
  tradable, fractionable, shortable,
  description, legacy_etf_id, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  e.symbol,
  e.name,
  'ETF'::"market_data"."AssetType",
  -- La devise historique est un VARCHAR libre : on ne convertit que ce qui
  -- correspond réellement à une valeur de l'enum, sinon USD par défaut.
  CASE upper(trim(e.currency))
    WHEN 'XAF' THEN 'XAF'::"billing"."Currency"
    WHEN 'EUR' THEN 'EUR'::"billing"."Currency"
    ELSE            'USD'::"billing"."Currency"
  END,
  e.isin,
  'ACTIVE'::"market_data"."AssetStatus",
  false,   -- tradable     : renseigné par broker-asset-sync
  false,   -- fractionable : renseigné par broker-asset-sync
  false,   -- shortable    : renseigné par broker-asset-sync
  e.description,
  e.id,
  now(),
  now()
FROM "market_data"."exchange_traded_fund" e
ON CONFLICT (legacy_etf_id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 2. colonnes spécifiques ETF -> etf_metadata
--
-- expense_ratio et dividend_yield passent de Decimal(6,4)/(5,4) à (9,6) :
-- aucune perte, la précision est élargie.
-- L'ancienne colonne "type" (ACC/DIST) devient distribution_policy, ce qui
-- libère le nom "type" pour l'enum STOCK/ETF au niveau de Asset.
-- -----------------------------------------------------------------------------
INSERT INTO "market_data"."etf_metadata" (
  id, asset_id,
  expense_ratio, dividend_yield, fund_family, category, region, sector,
  asset_class, risk_level, distribution_policy, distribution_frequency,
  inception_date, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  a.id,
  e.expense_ratio,
  e.dividend_yield,
  e.provider,
  e.category,
  e.region,
  e.sector,
  e.asset_class,
  e.risk_level,
  e.type,
  e.distribution_frequency,
  e.inception_date,
  now(),
  now()
FROM "market_data"."exchange_traded_fund" e
JOIN "market_data"."assets" a ON a.legacy_etf_id = e.id
ON CONFLICT (asset_id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 3. positions.asset_id
--
-- etf_id reste renseigné : les deux colonnes coexistent jusqu'à l'étape 3,
-- où etf_id sera retiré et asset_id passera NOT NULL.
-- -----------------------------------------------------------------------------
UPDATE "investing"."positions" p
SET asset_id = a.id
FROM "market_data"."assets" a
WHERE a.legacy_etf_id = p.etf_id
  AND p.asset_id IS NULL;


-- -----------------------------------------------------------------------------
-- 4. positions.currency
--
-- Les positions historiques sont valorisées en USD (avg_buy_price est un prix
-- Yahoo en dollars), alors que transactions.amount était en XAF. C'est
-- exactement la confusion de devises relevée en B13 de l'audit : on la fige
-- ici explicitement plutôt que de la laisser implicite.
-- -----------------------------------------------------------------------------
UPDATE "investing"."positions" p
SET currency = a.currency
FROM "market_data"."assets" a
WHERE a.id = p.asset_id;


-- -----------------------------------------------------------------------------
-- 5. connexions broker : RIEN À FAIRE ICI
--
-- Avec Alpaca OAuth, il n'existe aucun compte broker à pré-créer. Chaque ligne
-- de investing.broker_connections est produite par le callback OAuth, quand un
-- utilisateur autorise AMARA à accéder à SON PROPRE compte de courtage Alpaca.
--
-- Il n'y a donc pas de compte AMARA mutualisé à insérer, et surtout : aucun
-- jeton ne doit jamais être écrit par un script SQL. Les jetons sont chiffrés
-- par TokenEncryptionService avant persistance.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- Contrôle final
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_etf     integer;
  v_assets  integer;
  v_meta    integer;
  v_pos_nul integer;
BEGIN
  SELECT count(*) INTO v_etf     FROM "market_data"."exchange_traded_fund";
  SELECT count(*) INTO v_assets  FROM "market_data"."assets" WHERE legacy_etf_id IS NOT NULL;
  SELECT count(*) INTO v_meta    FROM "market_data"."etf_metadata";
  SELECT count(*) INTO v_pos_nul FROM "investing"."positions" WHERE asset_id IS NULL;

  RAISE NOTICE 'ETF sources          : %', v_etf;
  RAISE NOTICE 'Assets crees         : %', v_assets;
  RAISE NOTICE 'EtfMetadata crees    : %', v_meta;
  RAISE NOTICE 'Positions sans asset : %', v_pos_nul;

  IF v_assets <> v_etf THEN
    RAISE EXCEPTION
      'Backfill incomplet : % ETF en base pour seulement % assets crees. Verifier les symboles en doublon (preflight-phase2.sql, controle 5).', v_etf, v_assets;
  END IF;

  IF v_pos_nul > 0 THEN
    RAISE EXCEPTION
      'Backfill incomplet : % position(s) sans asset_id.', v_pos_nul;
  END IF;
END $$;

COMMIT;
