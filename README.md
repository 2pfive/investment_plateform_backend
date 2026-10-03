# Investment Platform — Backend

État des lieux du projet backend de la plateforme d'investissement (ETF), au 2026-08-31.

## Stack technique

- **Runtime / langage** : Node.js + TypeScript (ESM), exécuté via `tsx`/`nodemon` en dev, compilé avec `tsc` + `tsc-alias` en production.
- **Framework HTTP** : Express 5.
- **Base de données** : PostgreSQL via Prisma ORM 7 (`@prisma/client`, `@prisma/adapter-pg`).
- **Authentification** : JWT signé en RSA (`jsonwebtoken`), mots de passe hashés avec `bcrypt`.
- **Validation** : Zod.
- **Temps réel** : WebSocket (`ws`).
- **Tâches planifiées** : `node-cron` (worker de marché).
- **Données de marché** : `yahoo-finance2`.
- **Sécurité / middlewares** : `helmet`, `cors`, `express-rate-limit`, `cookie-parser`, `compression`, `morgan`.
- **Précision monétaire** : `decimal.js`.

Aucun framework de tests n'est configuré (`npm test` est un stub qui échoue volontairement). Pas de documentation API type Swagger/OpenAPI.

## Structure du projet

```
src/
  config/          env.ts, database.ts, clés RSA JWT (session_user_key_public/private.pem)
  lib/             prisma.ts, jsonwebtoken.ts, schemas.ts (zod), websocket.ts
  middlewares/     auth.middlewares.ts, rate.limiter.middlewares.ts, validate.middleware.ts
  modules/
    accounts/      account.controller/router/service.ts   (solde, dépôts)
    auth/          auth.controller/router/service.ts
    investing/     investing.controller/router/service.ts
    market/        market.controller/router/service.ts
    user/          user.controller/router/service.ts
  router/index.ts  point d'entrée des routes (+ routes ad-hoc /etf, /quote-history/:symbol)
  types/           api.types.ts, market.types.ts, portofolio.types.ts, user.types.ts, dto/
  utils/           errorHandler.ts, utils.ts
  workers/         market.worker.ts
prisma/schema.prisma
scripts/           SQL bruts (auth.user, billing, investing, market_data.etf) + CSV
```

## Fonctionnalités mises en place (API `/api/v1`)

### Authentification
- `POST /auth/login`, `POST /auth/register`, `GET /auth/me` (protégée).
- JWT RSA vérifié par le middleware `requireAuth` : le token est lu depuis un cookie (`COOKIE_JWT_NAME`) en priorité, sinon depuis l'en-tête `Authorization: Bearer <token>`.
- Mots de passe hashés avec `bcrypt` (`SALT_ROUNDS` configurable).

### Utilisateurs
- `POST /users` : création de compte (également utilisé comme alias register).

### Marché / ETF (public)
- `GET /market/etfs` : liste des ETF.
- `GET /market/quotes` : cotations.
- `GET /market/etf/:etf_id/details` : détails d'un ETF.
- `GET /market/etfs/:id/performance` : performance d'un ETF.
- `GET /etf`, `GET /quote-history/:symbol` : routes complémentaires (dont un passthrough Yahoo Finance).
- Diffusion de prix en temps réel via WebSocket, alimentée par un worker planifié (`market.worker.ts`, `node-cron`).

### Investissement (protégé)
- `POST /investing` : investir.
- `GET /investing/performances/:id` : performances d'un utilisateur.

### Facturation / comptes (protégé)
- `PATCH /billing/account/deposit` : dépôt de fonds.
- `GET /billing/account` : consultation du solde.

### Divers
- `GET /health` : point de santé du serveur (hors `/api/v1`).

### Fonctionnalité manquante
- Aucun endpoint **liste d'attente** ("waitlist") n'existe côté backend, alors que le frontend a récemment ajouté un formulaire de liste d'attente sur la landing page. Cette fonctionnalité doit encore être implémentée côté API si elle doit être fonctionnelle.

## Modèle de données (Prisma — schémas Postgres multiples)

- **`auth`** : `user` (id, user_id UUID, email, mot de passe, téléphone, date de naissance, statut actif, noms).
- **`billing`** : `accounts` (solde/devise par utilisateur), `transactions` (achat/vente/dépôt/retrait).
- **`investing`** : `portofolios`, `positions` (quantité, prix d'achat moyen), `portofolio_snapshots`.
- **`market_data`** : `exchange_traded_fund` (symbole, nom, devise, catégorie, niveau de risque, ratio de frais, ISIN, fournisseur…), `prices`, `etf_dividend`, `etf_holding`.

## Configuration / environnement

- `.env.development` : `SERVER_PORT`, `DATABASE_URL`, `ORIGINS` (CORS), `SALT_ROUNDS`, `COOKIE_JWT_NAME`, `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEY_PATH`/`JWT_PRIVATE_KEY_PASSPHRASE`, `EXCHANGE_RATE_URL`, `EXCHANGE_RATE_API_KEY`, ainsi que les variables `ALPACA_OAUTH_*`, `BROKER_*`, `MOBILE_RETURN_URL_ALLOWLIST` et `ORDER_*`/`FX_*` (voir `docs/ALPACA_OAUTH.md` et `docs/ORDERS.md`). Modèle sans secrets : `.env.example`.
- `.env.production` : présent mais vide — à compléter avant tout déploiement en production.
- `src/config/env.ts` : chargeur de configuration centralisé (CORS, port, sel bcrypt, nom du cookie, URL du taux de change).

**Point de sécurité** : `.env.development` contient des identifiants/API keys en clair versionnés dans le dépôt (clé de taux de change, token WhatsApp, mot de passe DB). À faire tourner/retirer du contrôle de version si ce n'est pas déjà prévu.

## Démarrage

```sh
npm install
npx prisma generate
npm run dev        # via nodemon/tsx
npm run build       # tsc + tsc-alias
```

## Points d'attention

- Pas de tests automatisés (unitaires ou intégration).
- Pas de documentation API (Swagger/OpenAPI) — à envisager pour faciliter l'intégration frontend.
- Endpoint waitlist à créer pour supporter la fonctionnalité déjà présente côté frontend.
- Secrets présents en clair dans `.env.development` versionné.
