# Ordres en argent réel

Un utilisateur connecté à Alpaca (voir `ALPACA_OAUTH.md`) investit un montant
dans sa devise. AMARA le convertit en dollars et transmet à Alpaca un **ordre
au marché en montant** (`notional`, `market`, `day`) sur **son propre**
compte.

## Routes (`/api/v1`, session obligatoire)

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| `POST` | `/orders/estimate` | Calcul sans effet : taux, frais, montant en dollars, actif, horloge |
| `POST` | `/orders` | Passage d'ordre. En-tête **`Idempotency-Key`** obligatoire |
| `GET` | `/orders?environment=&limit=&cursor=` | Liste paginée, du plus récent au plus ancien |
| `GET` | `/orders/:id` | Un ordre, relu chez le courtier s'il n'est pas terminé |

Corps de `POST /orders` et de `/orders/estimate` :

```json
{ "symbol": "SPY", "side": "BUY", "amount": "25000", "currency": "XAF", "environment": "PAPER" }
```

`amount` est une **chaîne** décimale. En XAF, un nombre entier de francs.

### Réponses de `POST /orders`

| Statut | Sens | Ce que le mobile doit dire |
| --- | --- | --- |
| `201` | Transmis au courtier (et peut-être déjà exécuté) | « Ordre transmis » |
| `202` | Issue inconnue : coupure pendant la transmission | « Confirmation en attente » — **pas** « échec » |
| `422 ORDER_REJECTED` | Refusé par le courtier ; l'ordre est tracé | Le message, tel quel |
| `422 ASSET_NOT_FRACTIONABLE` / `ASSET_NOT_TRADABLE` | Refusé avant envoi | Le message |
| `400 INVALID_AMOUNT` | Sous 1 $, au-dessus du plafond, centimes de franc | Le message |
| `503 FX_UNAVAILABLE` | Aucun taux récent : pas d'ordre sur un taux inventé | Réessayer plus tard |
| `409 BROKER_NOT_CONNECTED` | Compte non relié | Mener à la connexion |
| `422 IDEMPOTENCY_CONFLICT` | Clé déjà utilisée pour un autre ordre | Bug client : nouvelle clé |
| `409 IDEMPOTENCY_IN_PROGRESS` | Même clé, requête d'origine en cours | Réessayer avec la **même** clé |

Un rejeu (même clé, même corps) renvoie l'ordre existant, **dans son état
courant**, avec l'en-tête `Idempotent-Replayed: true`.

## Garanties

- **Un seul ordre par intention.** Clé d'idempotence côté mobile,
  `clientOrderId` générée côté serveur (`amara-<8 car. utilisateur>-<uuid>`).
  Vérifié : deux envois simultanés avec la même clé → un ordre, un seul envoi
  au courtier.
- **Une coupure n'est pas un échec.** L'ordre est cherché chez Alpaca par sa
  clé. Retrouvé : succès ordinaire. Introuvable : `202`, puis déclaré `FAILED`
  (`NOT_RECEIVED_BY_BROKER`) après 10 minutes sans trace. **Aucune
  retransmission automatique** : la documentation ne garantit pas le refus
  d'un `client_order_id` en double, et un renvoi à l'aveugle pourrait acheter
  deux fois.
- **Taux de change réel ou refus.** Chaque taux est historisé (`fx_rates`) et
  rattaché à l'ordre. Rafraîchi au-delà de `FX_REFRESH_SECONDS` ; au-delà de
  `FX_MAX_AGE_SECONDS`, l'ordre est refusé. L'ancien utilitaire du simulateur,
  qui retombe sur un taux codé en dur, n'est **pas** utilisé.
- **Arrondis au détriment de personne.** Frais arrondis vers le haut, dollars
  arrondis vers le bas au cent : on n'investit jamais plus que la saisie.
- **Actif relu à chaque ordre** (`tradable`, `fractionable`), fiche locale
  `assets` mise à jour.
- **Un refus n'est pas une révocation.** Alpaca répond `403` pour un pouvoir
  d'achat insuffisant : sur un passage d'ordre, ce `403` devient
  `ORDER_REJECTED` et la connexion reste active.
- **L'exécution vient du courtier.** Quantité et prix moyen ne sont remplis
  que par ce qu'Alpaca rapporte.
- **Pas de retour en arrière.** Un statut ne recule jamais, et un ordre
  terminé ne change plus. Seule exception : un ordre que l'on croyait perdu
  (`FAILED`) et que le courtier rapporte finalement.
- **Pas de statut deviné.** Un statut Alpaca inconnu laisse l'ordre en l'état
  et ouvre une entrée `reconciliation_logs`, sans doublon.
- **Pas de double écriture.** Les transitions sont conditionnelles au statut
  lu : le worker et une lecture simultanée ne dupliquent pas les événements.

## Frais

`ORDER_FEE_RATE=0` par défaut. **Par OAuth, AMARA ne peut prélever aucun
frais** : aucun périmètre ne permet de virement. Un taux non nul réduirait
seulement le montant investi, sans que la différence n'arrive jamais chez
AMARA.

## Synchronisation

`src/workers/broker-order-sync.worker.ts`, démarré avec le serveur si le
courtier est configuré. Toutes les `ORDER_SYNC_INTERVAL_SECONDS` (15 s), il
relit les ordres non terminés : à chaque passage pendant leurs 5 premières
minutes, puis toutes les 2 minutes (un ordre en file la nuit n'a pas besoin
d'être relu toutes les 15 s).

Le flux temps réel `trade_updates` viendra **en complément** : son
authentification OAuth est contradictoire dans la documentation d'Alpaca et
doit être testée en paper. Le worker restera le filet qui rattrape un message
manqué.

## Hors séance

Un ordre `day` passé hors séance est **mis en file jusqu'à l'ouverture** (doc
Alpaca), pas refusé. L'API ne le bloque pas ; elle renvoie l'horloge de marché
(`market.isOpen`, `market.nextOpen`) pour que le mobile l'annonce.

## Vérification

```bash
npm run verify:orders
```

50 contrôles contre un faux Alpaca et un faux fournisseur de taux : estimation,
idempotence (rejeu, conflit, envoi simultané), exécution par lecture et par
worker, refus avant et après envoi, coupure avec ordre retrouvé et avec ordre
perdu, statut inconnu, taux indisponible, cloisonnement entre utilisateurs,
pagination, absence de secrets dans les journaux. Nettoie tout et restaure les
fiches d'actifs modifiées.

## À vérifier en paper, avec de vrais identifiants

- Réponse exacte d'Alpaca à un `client_order_id` en double.
- Nombre de décimales accepté par `notional` (AMARA envoie des cents).
- Codes et messages exacts d'un refus pour fonds ou position insuffisants.
- Qu'une autorisation `trading` suffit pour `GET /v2/assets` et `/v2/clock`.
