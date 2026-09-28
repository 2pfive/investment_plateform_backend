# AMARA — base de données

Dernière mise à jour : 2026-08-31 (Phase 2).

Ce document décrit le schéma après la refonte additive, les conventions retenues,
et la marche à suivre pour appliquer la migration.

---

## 1. Principe de la Phase 2

La refonte est **additive**. Le frontend web Vue 3 tourne en production contre ce
backend : il ne doit rien voir changer.

Concrètement :

| Règle | Conséquence |
|---|---|
| Les 5 schémas PostgreSQL sont conservés | `account`, `auth`, `billing`, `investing`, `market_data` |
| Les 10 modèles existants gardent leur nom Prisma **et** leur nom de table | `prisma.portofolios`, `prisma.accounts`… continuent de fonctionner |
| Toute colonne ajoutée est nullable ou pourvue d'un `DEFAULT` | Aucun `INSERT` existant ne casse |
| Aucune colonne supprimée, aucune rétrécie | Seuls des **élargissements** de précision Decimal |
| Les nouveaux modèles suivent la convention cible | `PascalCase` + `@map`/`@@map` vers du `snake_case` |

Le renommage (`portofolios` → `Portfolio`, `accounts` → `Account`…) est
**volontairement reporté à l'étape 3**, quand les services seront réécrits.
Renommer un modèle Prisma change le client généré et casserait immédiatement
les six fichiers de service qui l'utilisent.

**Vérification de non-régression effectuée :** `npx tsc --noEmit` après
`prisma generate` ne produit **aucune erreur liée à Prisma**. Le seul diagnostic
restant concerne `server.listen(config.port, '0.0.0.0', …)` dans `src/index.ts`,
antérieur à cette refonte (`config.port` est typé `string | number`).

---

## 2. Conventions de précision

**Aucun `Float`, nulle part.** Les montants transitent en `Decimal` côté Prisma et
en **chaîne** côté JSON.

| Nature | Type SQL | Pourquoi |
|---|---|---|
| Montants, soldes, frais, valeurs, P&L | `numeric(24,8)` | Plafond confortable en XAF, 8 décimales pour les arrondis intermédiaires |
| Prix | `numeric(24,8)` | Aligné sur les montants |
| **Quantités** | `numeric(24,9)` | **Limite Alpaca** sur les fractions d'action |
| Taux de change | `numeric(24,12)` | XAF→USD vaut ~0,0017 : 8 décimales perdraient de la résolution |
| Ratios (expense ratio, poids) | `numeric(9,6)` | Suffisant à 0,0001 % près |

### La correction la plus importante

`investing.positions.quantity` passait de `numeric(12,4)` à `numeric(24,9)`.

Avec 4 décimales, 10 000 XAF (≈ 17,7 USD) sur SPY à ~660 USD donnaient
0,0268… actions, arrondies. Sur un titre coté quelques centaines de milliers de
dollars, la quantité tombait à `0.0000` : **la position devenait nulle**.
C'était bloquant pour tout le modèle d'investissement fractionné d'AMARA.

Attention : élargir la colonne ne restaure pas la précision **déjà** perdue sur
les lignes existantes. Le contrôle n°6 de `preflight-phase2.sql` liste les
positions concernées.

---

## 3. Ce qui a été ajouté

### Nouvelles tables

| Table | Schéma | Rôle |
|---|---|---|
| `orders` | `investing` | Le modèle central absent du schéma d'origine |
| `order_events` | `investing` | Journal append-only des transitions de statut |
| `broker_connections` | `investing` | Connexion OAuth vers le compte Alpaca **de l'utilisateur** |
| `oauth_states` | `investing` | State OAuth à usage unique, vérifié au callback |
| `idempotency_keys` | `investing` | Empêche qu'un retry réseau crée deux ordres Alpaca |
| `reconciliation_logs` | `investing` | Trace les divergences AMARA/broker |
| `assets` | `market_data` | Modèle générique **STOCK + ETF** |
| `etf_metadata` | `market_data` | Les colonnes spécifiques ETF, sorties d'`Asset` |
| `market_prices` | `market_data` | OHLCV avec granularité et source |
| `fx_rates` | `market_data` | Taux historisés, auditables |

### Colonnes ajoutées aux tables existantes

| Table | Colonnes |
|---|---|
| `auth.user` | `updated_at`, `kyc_status`, `country` |
| `billing.accounts` | `reserved_balance`, `updated_at` |
| `billing.transactions` | `status`, `currency`, `fee`, `reference`, `external_reference`, `order_id`, `metadata`, `updated_at` |
| `investing.portofolios` | `base_currency`, `total_value`, `updated_at` |
| `investing.positions` | `asset_id`, `currency`, `current_price`, `market_value`, `unrealized_pnl`, `realized_pnl`, `broker_quantity`, `last_synced_at`, `updated_at` |
| `investing.portofolio_snapshots` | `currency`, `cash_balance` |

### Contraintes réparées

- `positions(portofolio_id, etf_id)` devient **unique**. Sans elle, le
  `findFirst` + `create` du service actuel produit des doublons dès que deux
  investissements concurrents portent sur le même actif.
- `portofolio_snapshots.portofolio_id` obtient enfin une **clé étrangère**.
  C'était un UUID orphelin, sans lien déclaré vers `portofolios`.

---

## 4. Trois décisions à connaître

### `Asset` et `EtfMetadata` sont séparés

`exchange_traded_fund` comptait 18 colonnes, dont 8 propres aux ETF
(`expense_ratio`, `provider`, `distribution_frequency`…). Toutes auraient été
systématiquement `NULL` sur une action — d'où l'impossibilité de représenter un
titre avec ce modèle.

`Asset` ne garde que ce qui est vrai pour un STOCK comme pour un ETF.
`EtfMetadata` porte le reste, en relation 1-1 optionnelle. Le coût est un
`include` de plus, déjà nécessaire pour l'écran détail.

### `broker_connections` : AMARA ne détient rien

Avec **Alpaca OAuth**, le compte de courtage appartient à l'utilisateur. AMARA
ne détient ni titres ni liquidités : elle dispose seulement d'une autorisation
OAuth pour agir au nom de l'utilisateur sur **son propre** compte Alpaca.

Trois conséquences directes sur le schéma.

**1. `user_id` est obligatoire**, et `@@unique([userId, provider, environment])`
garantit une connexion par utilisateur, fournisseur et environnement. `PAPER` et
`LIVE` sont deux lignes distinctes : les endpoints ne se mélangent jamais.

**2. Le jeton n'est jamais stocké en clair.** La
[documentation Alpaca](https://docs.alpaca.markets/us/docs/using-oauth2-and-trading-api)
indique que la réponse du token endpoint contient uniquement `access_token`,
`token_type` et `scope` — **ni `expires_in`, ni `refresh_token`**. Le jeton est
donc une crédentielle à durée de vie indéterminée, ce qui rend le chiffrement au
repos obligatoire et non optionnel :

| Colonne | Contenu |
|---|---|
| `access_token_ciphertext` | AES-256-GCM (iv + tag + ciphertext) |
| `encryption_key_id` | identifie la clé, permet la rotation |
| `access_token_fingerprint` | SHA-256, pour tracer sans exposer le secret |

`refresh_token_ciphertext` et `token_expires_at` existent mais restent
**nullables et inutilisés** : ils ne serviront que si Alpaca les introduit.
La seule voie de récupération après `EXPIRED` ou `REVOKED` est une
**ré-autorisation complète**, pas un rafraîchissement — c'est une contrainte
d'UX mobile, pas seulement de backend.

**3. `billing.accounts` n'est plus la source de financement.** Le cash et le
buying power vivent chez Alpaca. `reserved_balance` reste en place pour un futur
wallet XAF AMARA (dépôts / retraits, hors périmètre du MVP) mais
`InvestmentService` ne doit pas le lire : le contrôle de solde interroge
`GET /v2/account` chez Alpaca.

### `oauth_states`

Le `state` OAuth doit être cryptographiquement aléatoire, lié à l'utilisateur, et
à usage unique. Il est donc persisté : le processus qui reçoit le callback n'est
pas nécessairement celui qui a généré l'URL d'autorisation. `consumed_at` bloque
le rejeu, `expires_at` borne la fenêtre.

### `orders` porte deux devises

| Colonne | Contenu | Exemple |
|---|---|---|
| `requested_amount` / `requested_currency` | L'intention utilisateur | `10000` XAF |
| `notional` / `trading_currency` | Ce qui part chez le broker | `17.68` USD |
| `fx_rate` / `fx_rate_id` | Le taux appliqué, figé et historisé | `0.001768100000` |

Sans les trois, un ordre n'est pas auditable a posteriori : le taux de change ne
peut pas être re-récupéré après coup auprès du fournisseur.

---

## 5. Appliquer la migration

La base n'avait **jamais été migrée par Prisma** : elle a été construite par les
scripts SQL de `scripts/` puis introspectée. Il faut donc la « baseliner » avant
d'appliquer quoi que ce soit.

### Étape 1 — diagnostic (lecture seule)

```bash
psql "$DATABASE_URL" -f prisma/preflight-phase2.sql
```

Deux contrôles sont bloquants : les doublons de position et les snapshots
orphelins. La migration s'arrête avec un message explicite s'ils subsistent.
**Rien n'est corrigé automatiquement** — ce sont des positions financières
réelles, leur fusion relève d'une décision, pas d'un script.

### Étape 2 — baseline

`prisma/migrations/0_init/` décrit l'état **actuel** de la base. Il ne doit
jamais être exécuté, seulement marqué comme déjà appliqué :

```bash
npx prisma migrate resolve --applied 0_init
```

### Étape 3 — appliquer

```bash
npx prisma migrate deploy
```

Deux migrations s'exécutent :

| Migration | Contenu |
|---|---|
| `20260831120000_phase2_enum_values` | Les 3 `ALTER TYPE ... ADD VALUE` sur `transaction_type` |
| `20260831120100_phase2_additive` | Tout le reste, précédé des deux contrôles bloquants |

Les valeurs d'enum sont isolées **volontairement** : `ALTER TYPE ... ADD VALUE`
ne s'exécute pas dans un bloc transactionnel sur PostgreSQL ≤ 11, et sur
PostgreSQL ≥ 12 la valeur ajoutée n'est pas utilisable dans la même transaction.
Prisma exécutant chaque `migration.sql` dans une transaction, les séparer élimine
les deux problèmes.

### Étape 4 — backfill

```bash
psql "$DATABASE_URL" -f prisma/backfill-phase2.sql
```

Le script ne crée **aucune** connexion broker : avec OAuth, chaque ligne de
`broker_connections` naît du callback, quand un utilisateur autorise AMARA sur
son propre compte. Aucun jeton n'est jamais écrit par un script SQL.

Le script est idempotent et se termine par un contrôle qui échoue si le nombre
d'`assets` créés ne correspond pas au nombre d'ETF sources.

### Étape 5 — régénérer le client

```bash
npx prisma generate
```

---

## 6. Ce qui reste à faire (étape 3)

Ces changements **cassent** le client Prisma actuel et sont donc groupés avec la
réécriture des services :

- renommer les modèles : `portofolios` → `Portfolio`, `accounts` → `Account`,
  `positions` → `Position`, `transactions` → `Transaction`, `user` → `User` ;
- passer `positions.asset_id` en `NOT NULL` et retirer `etf_id` ;
- passer `accounts.balance` en `NOT NULL` (le code teste `!account.balance`, ce
  qui est vrai pour un solde de 0 — bug latent) ;
- poser `@@unique` sur `accounts(user_id, currency)` et `portofolios(user_id)` ;
- rattacher `etf_holding` et `etf_dividend` à `Asset` ;
- retirer `transaction_type` au profit de `TransactionType` en majuscules,
  sans valeur par défaut ;
- retirer le schéma `account`, déclaré dans la datasource mais **vide** ;
- déprécier puis supprimer `exchange_traded_fund` et `prices`, une fois le
  frontend web migré sur les routes v1.
