# Connexion des comptes Alpaca — mise en service

Le backend connaît deux modes. **Le mode actif aujourd'hui est le compte
partagé.**

| Mode | Activé par | Comptes Alpaca |
| --- | --- | --- |
| **Compte partagé** | `ALPACA_KEY` + `ALPACA_SECRET` + `ALPACA_KEY_ENVIRONMENT` renseignées | **Un seul**, celui des clés, pour tous les utilisateurs AMARA |
| OAuth | `ALPACA_KEY` vide, `ALPACA_OAUTH_*` renseignées | Un par utilisateur, relié par lui-même |

## Deux sortes d'identifiants Alpaca, à ne pas confondre

| Identifiants | Où les obtenir | Servent à |
| --- | --- | --- |
| **Clés API** (`AK…` en live, `PK…` en paper) + secret | Tableau de bord Alpaca → API Keys | Agir sur **ce** compte : mode compte partagé |
| **`client_id` + `client_secret`** | Alpaca Connect → « My Developed Apps » | Demander à d'autres titulaires l'accès à **leur** compte : mode OAuth |

Les unes ne remplacent pas les autres. Des clés API ne permettent pas de faire
de l'OAuth, et un `client_id` ne donne accès à aucun compte à lui seul.

## Mode compte partagé (Trading API, clés du compte)

```dotenv
ALPACA_KEY=AK…
ALPACA_SECRET=…
ALPACA_KEY_ENVIRONMENT=LIVE        # celui des clés : LIVE (AK…) ou PAPER (PK…)
BROKER_DEFAULT_ENVIRONMENT=LIVE
BROKER_ALLOWED_ENVIRONMENTS=LIVE
BROKER_TOKEN_KEY_ID=…              # toujours requis (configuration commune)
BROKER_TOKEN_KEY=…
ORDER_MAX_NOTIONAL_USD=20          # garde-fou en argent réel
```

Côté mobile : `EXPO_PUBLIC_BROKER_ENVIRONMENT=LIVE`.

### Basculer paper ↔ live depuis le backend seul

```dotenv
ALPACA_PAPER_KEY=PK…
ALPACA_PAPER_SECRET=…
ALPACA_LIVE_KEY=AK…                # facultatif : à défaut, ALPACA_KEY si LIVE
ALPACA_LIVE_SECRET=…
ALPACA_TRADING_MODE=PAPER          # ou LIVE ; doit figurer dans BROKER_ALLOWED_ENVIRONMENTS
```

En mode compte partagé, le serveur impose son environnement : le paramètre
`environment` envoyé par l'application est ignoré, et les réponses portent
l'environnement réel (`paper: true` en simulation). Changer
`ALPACA_TRADING_MODE` puis redémarrer suffit ; aucune nouvelle version de
l'application n'est nécessaire. Les ordres et l'historique sont séparés par
environnement : en PAPER, l'application ne montre que les ordres paper.

Rien d'autre : pas d'application Alpaca Connect, pas d'adresse de rappel, pas
d'étape de liaison. Tout utilisateur AMARA connecté trade sur ce compte.

Fonctionnement :

- `GET /broker/connection` relit le compte chez Alpaca (`GET /v2/account`) :
  `CONNECTED` avec le numéro masqué, ou `ERROR` si les clés sont refusées.
  Un environnement autre que celui des clés répond `NOT_CONNECTED`.
- `withBroker` crée à la volée, pour chaque utilisateur, une ligne
  `broker_connections` **sans jeton** : les ordres s'y rattachent, et c'est par
  elle que la liste et le worker de suivi retrouvent leur environnement.
- Les clés partent en en-têtes `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`,
  jamais en base.
- Chaque ordre reste attribué à son utilisateur AMARA. Chez Alpaca, en
  revanche, il n'existe qu'un portefeuille global : la répartition entre
  utilisateurs n'existe que dans la base AMARA.
- `POST /broker/alpaca/authorize` répond `503 BROKER_NOT_CONFIGURED` tant
  qu'OAuth n'est pas configuré. `DELETE /broker/connection` n'a pas d'effet
  durable : la ligne repasse `CONNECTED` au prochain ordre.

**Limite.** Adapté à un test sur son propre argent. Un compte unique pour
l'argent de plusieurs personnes est une structure omnibus : ni Alpaca ni AMARA
ne cloisonnent les fonds, et cela relève d'obligations réglementaires.

Vérification sans ordre, après configuration : démarrer le backend et appeler
`GET /api/v1/broker/connection` avec une session. `npm run verify:broker` et
`verify:orders` testent le mode OAuth contre un faux Alpaca ; ils ignorent les
clés du `.env`.

---

# Mode OAuth

Chaque utilisateur relie **son propre** compte Alpaca à son compte AMARA.
AMARA ne détient ni titres ni espèces ; le backend conserve seulement un jeton
d'accès, chiffré.

## Ce qui est en place

| Élément | Emplacement |
| --- | --- |
| Configuration, validée à la demande | `src/config/broker.config.ts` |
| Chiffrement AES-256-GCM des jetons | `src/lib/crypto/token-cipher.ts` |
| Ports (aucun type Alpaca au-delà) | `src/ports/broker.port.ts`, `broker.errors.ts` |
| Adaptateurs Alpaca | `src/infrastructure/brokers/alpaca/` |
| Seul endroit qui nomme Alpaca | `src/infrastructure/brokers/broker.factory.ts` |
| Service, contrôleur, routes | `src/modules/broker/` |
| Colonne `oauth_states.return_url` | migration `20260914120000_oauth_state_return_url` |
| Vérification de bout en bout | `npm run verify:broker` |

### Routes (`/api/v1`)

| Méthode | Chemin | Session | Rôle |
| --- | --- | --- | --- |
| `POST` | `/broker/alpaca/authorize` | oui | Ouvre une autorisation. Corps : `{ returnUrl, environment? }` |
| `GET` | `/broker/alpaca/callback` | **non** | Rappel d'Alpaca. Authentifié par le `state` |
| `GET` | `/broker/connection?environment=PAPER\|LIVE` | oui | État de la connexion |
| `DELETE` | `/broker/connection?environment=PAPER\|LIVE` | oui | Efface le jeton. `204`, idempotent |

Le rappel redirige vers l'application avec `?result=connected`, `denied`,
`expired`, `already_linked` ou `error` — jamais de jeton, jamais de donnée de
compte. L'application relit ensuite l'état par la route authentifiée.

### Garanties vérifiées par `npm run verify:broker`

- `state` à usage unique, consommé atomiquement ; rejeu et expiration refusés.
- Adresse de retour validée contre la liste blanche sur l'URL analysée
  (`http://localhost:8081.attaquant.com` est refusé).
- Jeton chiffré en base, lié à son utilisateur et à son environnement : un
  chiffré recopié sur une autre ligne ne se déchiffre pas.
- Aucun jeton ni `client_secret` dans les réponses ou les journaux.
- Un même compte Alpaca ne peut être relié qu'à un seul compte AMARA par
  environnement.
- Une reconnexion ratée ne dégrade pas une connexion active.
- Un jeton refusé par Alpaca fait passer la connexion en `REVOKED`.
- **Le serveur démarre sans configuration Alpaca** : seules les routes
  `/broker/*` répondent `503 BROKER_NOT_CONFIGURED`, le frontend web n'est pas
  affecté.

Le script lance un faux serveur Alpaca en local : il ne contacte pas Alpaca et
ne demande aucun identifiant.

## Mise en service

### 1. Enregistrer l'application

Tableau de bord Alpaca → **Alpaca Connect** → « My Developed Apps » →
« Submit Your App ». On obtient `client_id` et `client_secret`.

- **Redirect URI** : l'adresse publique de la route de rappel, par exemple
  `https://api.amara.example/api/v1/broker/alpaca/callback`. Elle doit être
  identique, caractère pour caractère, à `ALPACA_OAUTH_REDIRECT_URI`.
- **Revue** : le trading réel sur un compte autre que celui du développeur qui
  enregistre l'application exige la revue d'Alpaca. Préciser dans le
  formulaire que l'usage est interne à l'équipe et non commercial.

### 2. Rendre le rappel joignable depuis un téléphone

Le rappel est ouvert par le **navigateur du téléphone** : `localhost` n'y
désigne pas le poste de développement. **À vérifier à l'enregistrement** :
Alpaca peut exiger une adresse HTTPS. Si c'est le cas, exposer le backend
local par un tunnel (Cloudflare Tunnel, ngrok…) et déclarer l'adresse du
tunnel.

### 3. Renseigner `.env.development`

Vider d'abord `ALPACA_KEY` : renseignée, elle active le compte partagé, qui
prime sur OAuth.

```dotenv
ALPACA_OAUTH_CLIENT_ID=…
ALPACA_OAUTH_CLIENT_SECRET=…
ALPACA_OAUTH_REDIRECT_URI=https://<tunnel>/api/v1/broker/alpaca/callback
ALPACA_OAUTH_SCOPES=trading
BROKER_DEFAULT_ENVIRONMENT=PAPER
BROKER_ALLOWED_ENVIRONMENTS=PAPER,LIVE
BROKER_TOKEN_KEY_ID=k20260914
BROKER_TOKEN_KEY=<déjà généré>
MOBILE_RETURN_URL_ALLOWLIST=amara:,exp://192.168.1.10:8081,http://localhost:8081
```

`MOBILE_RETURN_URL_ALLOWLIST` doit contenir l'adresse qu'utilise
l'application : `amara:` pour un build, `exp://<IP du poste>:8081` pour Expo
Go, `http://localhost:8081` pour l'aperçu web.

`BROKER_TOKEN_KEY` a été généré le 14 septembre 2026. **Ne jamais le remplacer
sans rotation** : les jetons déjà enregistrés deviendraient illisibles.

### 4. Vérifier

```bash
npm run verify:broker
```

Puis, avec les vrais identifiants, un premier parcours en **paper** avant tout
passage en live.

## Rotation de la clé de chiffrement

1. Générer une clé :
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. Déplacer l'ancienne dans `BROKER_TOKEN_PREVIOUS_KEYS=k20260914:<ancienne>`.
3. Poser la nouvelle dans `BROKER_TOKEN_KEY` avec un nouvel
   `BROKER_TOKEN_KEY_ID`.

Chaque jeton est rechiffré avec la nouvelle clé à sa prochaine utilisation.
L'ancienne peut être retirée quand plus aucune ligne de `broker_connections`
ne porte son identifiant.

## Limites connues

- **Révocation côté Alpaca** : la documentation ne décrit pas de point de
  révocation. `DELETE /broker/connection` efface le jeton chez AMARA ;
  l'utilisateur retire l'accès depuis son espace Alpaca.
- **Détection d'une révocation** : elle a lieu au prochain appel au courtier
  (`withBroker`), pas en temps réel.
- **Limiteur de débit en mémoire** : suffisant en instance unique, à déplacer
  vers un stockage partagé si le backend passe à plusieurs instances.
- **Prochaine phase** : ordres `notional` et suivi `trade_updates`, qui
  passeront par `BrokerConnectionService.withBroker`.
