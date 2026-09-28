-- =============================================================================
-- AMARA Phase 2 — diagnostic AVANT migration
--
-- Script STRICTEMENT en lecture : aucun INSERT, UPDATE, DELETE ni DDL.
-- À lancer avant `prisma migrate deploy` pour savoir si les données passent.
--
--   psql "$DATABASE_URL" -f prisma/preflight-phase2.sql
--
-- Deux contrôles peuvent bloquer la migration. Les autres sont informatifs.
-- =============================================================================


\echo '=============================================================='
\echo ' 1. BLOQUANT — doublons de position (portofolio_id, etf_id)'
\echo '=============================================================='

SELECT
  p.portofolio_id,
  p.etf_id,
  e.symbol,
  count(*)      AS nb_lignes,
  sum(p.quantity) AS quantite_totale,
  array_agg(p.id ORDER BY p.created_at) AS ids
FROM "investing"."positions" p
LEFT JOIN "market_data"."exchange_traded_fund" e ON e.id = p.etf_id
GROUP BY p.portofolio_id, p.etf_id, e.symbol
HAVING count(*) > 1
ORDER BY count(*) DESC;

\echo ''
\echo '--> 0 ligne = OK. Sinon, fusionner chaque groupe en UNE position :'
\echo '    quantity  = somme des quantités'
\echo '    avg_buy_price = somme(quantity * avg_buy_price) / somme(quantity)'
\echo '    puis supprimer les lignes redondantes.'
\echo '    Ne PAS automatiser : ce sont des positions financières réelles.'
\echo ''


\echo '=============================================================='
\echo ' 2. BLOQUANT — snapshots orphelins'
\echo '=============================================================='

SELECT
  count(*)          AS snapshots_orphelins,
  min(s.recorded_at) AS plus_ancien,
  max(s.recorded_at) AS plus_recent,
  count(DISTINCT s.portofolio_id) AS portefeuilles_inexistants
FROM "investing"."portofolio_snapshots" s
WHERE NOT EXISTS (
  SELECT 1 FROM "investing"."portofolios" p WHERE p.id = s.portofolio_id
);

\echo ''
\echo '--> 0 = OK. Sinon, ces lignes référencent des portefeuilles supprimés'
\echo '    et devront être purgées avant la migration.'
\echo ''


\echo '=============================================================='
\echo ' 3. INFO — comptes multiples par utilisateur'
\echo '=============================================================='
\echo 'Le code prend systematiquement accounts[0] : plusieurs comptes rendent'
\echo 'le comportement non deterministe.'

SELECT user_id, count(*) AS nb_comptes, array_agg(currency) AS devises
FROM "billing"."accounts"
GROUP BY user_id
HAVING count(*) > 1;


\echo ''
\echo '=============================================================='
\echo ' 4. INFO — portefeuilles multiples par utilisateur'
\echo '=============================================================='

SELECT user_id, count(*) AS nb_portefeuilles
FROM "investing"."portofolios"
GROUP BY user_id
HAVING count(*) > 1;


\echo ''
\echo '=============================================================='
\echo ' 5. INFO — symboles ETF en doublon'
\echo '=============================================================='
\echo 'assets.symbol sera UNIQUE : un doublon ici fera echouer le backfill.'

SELECT symbol, count(*) AS nb, array_agg(id) AS ids
FROM "market_data"."exchange_traded_fund"
GROUP BY symbol
HAVING count(*) > 1;


\echo ''
\echo '=============================================================='
\echo ' 6. INFO — quantités déjà écrasées par la précision Decimal(12,4)'
\echo '=============================================================='
\echo 'Ces positions ont ete arrondies a 4 decimales et ne pourront pas etre'
\echo 'reconstituees : elargir la colonne ne restaure pas la precision perdue.'

SELECT
  p.id,
  e.symbol,
  p.quantity,
  p.avg_buy_price,
  p.quantity * p.avg_buy_price AS valeur_achat_usd
FROM "investing"."positions" p
LEFT JOIN "market_data"."exchange_traded_fund" e ON e.id = p.etf_id
WHERE p.quantity = 0
   OR p.quantity < 0.001
ORDER BY p.quantity;


\echo ''
\echo '=============================================================='
\echo ' 7. INFO — volumétrie'
\echo '=============================================================='

SELECT 'auth.user'                       AS table_, count(*) FROM "auth"."user"
UNION ALL SELECT 'billing.accounts',              count(*) FROM "billing"."accounts"
UNION ALL SELECT 'billing.transactions',          count(*) FROM "billing"."transactions"
UNION ALL SELECT 'investing.portofolios',         count(*) FROM "investing"."portofolios"
UNION ALL SELECT 'investing.positions',           count(*) FROM "investing"."positions"
UNION ALL SELECT 'investing.portofolio_snapshots',count(*) FROM "investing"."portofolio_snapshots"
UNION ALL SELECT 'market_data.exchange_traded_fund', count(*) FROM "market_data"."exchange_traded_fund"
UNION ALL SELECT 'market_data.prices',            count(*) FROM "market_data"."prices"
UNION ALL SELECT 'market_data.etf_holding',       count(*) FROM "market_data"."etf_holding"
UNION ALL SELECT 'market_data.etf_dividend',      count(*) FROM "market_data"."etf_dividend";


\echo ''
\echo '=============================================================='
\echo ' 8. INFO — version PostgreSQL'
\echo '=============================================================='
\echo 'ALTER TYPE ... ADD VALUE exige PostgreSQL >= 12 hors transaction.'
\echo 'La migration 20260831120000 isole ces instructions pour cette raison.'

SELECT version();
