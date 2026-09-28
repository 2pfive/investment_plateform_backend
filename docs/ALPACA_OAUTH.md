# Connexion des comptes Alpaca (OAuth) — mise en service

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
