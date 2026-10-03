/**
 * ============================================================
 * PORTS DU COURTIER
 * ============================================================
 *
 * Les seules interfaces que les services connaissent. Aucun type propre à
 * Alpaca ne franchit cette frontière : ni `AlpacaAccount`, ni URL `/v2/…`,
 * ni code d'erreur HTTP du courtier.
 *
 * Deux ports distincts, parce qu'ils ne vivent pas au même rythme :
 *
 * - `BrokerAuthorizationPort` relie un compte — une fois par utilisateur et
 *   par environnement. Il est propre au modèle OAuth : le jour où les comptes
 *   seront ouverts via Alpaca Broker API, ce port disparaît sans que
 *   `BrokerProvider` bouge.
 *
 * - `BrokerProvider` agit sur un compte relié : compte, actifs, horloge,
 *   ordres.
 *
 * Tous les montants, prix et quantités sont des chaînes décimales. Jamais de
 * `number` : un ordre en argent réel ne tolère pas l'arrondi binaire.
 */

export type BrokerEnvironment = "PAPER" | "LIVE";

/**
 * Ce dont le fournisseur a besoin pour agir sur un compte.
 *
 * Le jeton y circule déchiffré : ce contexte ne doit exister qu'en mémoire,
 * le temps d'un appel, et ne jamais être sérialisé ni journalisé.
 */
export interface BrokerContext {
  environment: BrokerEnvironment;
  accessToken: string;
}

/** Compte de courtage, dans le vocabulaire d'AMARA. */
export interface BrokerAccount {
  /** Identifiant technique du compte chez le courtier. */
  externalId: string;
  /** Numéro de compte, tel que le courtier l'affiche à son client. */
  accountNumber: string;
  /** Statut brut du courtier (`ACTIVE`, `ACCOUNT_CLOSED`…), pour diagnostic. */
  status: string;
  /** Le compte peut-il passer des ordres ? */
  canTrade: boolean;
  currency: string;
  cash: string;
  buyingPower: string;
  /** Valeur totale du compte (espèces + titres), et à la clôture précédente. */
  equity: string;
  lastEquity: string;
}

/** Position détenue sur le compte, valorisée par le courtier. USD. */
export interface BrokerPosition {
  symbol: string;
  quantity: string;
  averageEntryPrice: string;
  currentPrice: string;
  marketValue: string;
  costBasis: string;
  unrealizedPl: string;
  /** Pourcentage, ex. "4.12". */
  unrealizedPlPercent: string;
  changeTodayPercent: string;
}

/** Périodes des graphiques, dans le vocabulaire de l'application. */
export type HistoryRange = "1J" | "1S" | "1M" | "3M" | "1A" | "TOUT";

/** Point d'une série : horodatage ISO et valeur décimale. */
export interface SeriesPoint {
  at: string;
  value: string;
}

/** Dernier cours connu d'un symbole et sa variation sur la séance. USD. */
export interface MarketSnapshot {
  symbol: string;
  price: string | null;
  previousClose: string | null;
  /** Pourcentage, ex. "-0.94". `null` sans clôture précédente. */
  changePercent: string | null;
  at: string | null;
}

export interface NewsArticle {
  id: string;
  headline: string;
  source: string;
  url: string | null;
  publishedAt: string;
  symbols: string[];
}

/** Actif négociable chez le courtier. */
export interface BrokerAsset {
  externalId: string;
  symbol: string;
  name: string;
  exchange: string | null;
  /** Le courtier accepte-t-il des ordres sur cet actif ? */
  tradable: boolean;
  /** Les ordres en montant (fractionnés) sont-ils acceptés ? */
  fractionable: boolean;
  shortable: boolean;
  active: boolean;
}

export interface MarketClock {
  isOpen: boolean;
  /** Horodatages ISO. */
  nextOpen: string;
  nextClose: string;
  timestamp: string;
}

/**
 * Statut d'un ordre, dans le vocabulaire d'AMARA — aligné sur l'enum Prisma
 * `OrderStatus`. `CREATED` et `FAILED` ne viennent jamais du courtier : ils
 * décrivent un ordre qu'AMARA n'a pas (encore) réussi à lui transmettre.
 */
export type OrderStatusName =
  | "CREATED"
  | "SUBMITTED"
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "FAILED";

export type OrderSideName = "BUY" | "SELL";

/** Ordre tel que le courtier le rapporte. */
export interface BrokerOrder {
  externalId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSideName;
  /**
   * Statut traduit, ou `null` si le courtier a renvoyé un statut inconnu. Un
   * statut inconnu n'est jamais deviné : l'ordre garde son état précédent et
   * l'écart part en réconciliation.
   */
  status: OrderStatusName | null;
  /** Statut brut du courtier, conservé pour l'audit. */
  rawStatus: string;
  notional: string | null;
  quantity: string | null;
  filledQuantity: string;
  averageFilledPrice: string | null;
  submittedAt: string | null;
  filledAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  failedAt: string | null;
  updatedAt: string | null;
}

/**
 * Ordre au marché exprimé en MONTANT — la seule forme qu'AMARA émet.
 *
 * Alpaca impose `market` et `day` pour un ordre `notional` : ils ne sont pas
 * paramétrables ici, pour qu'aucun appelant ne puisse composer une
 * combinaison que le courtier refusera.
 */
export interface NotionalOrderRequest {
  symbol: string;
  side: OrderSideName;
  /** Dollars, deux décimales au plus. */
  notional: string;
  /** Clé d'idempotence côté courtier : 128 caractères au plus. */
  clientOrderId: string;
}

export interface AuthorizationRequest {
  state: string;
  redirectUri: string;
  environment: BrokerEnvironment;
  scopes: string;
}

export interface GrantedAuthorization {
  accessToken: string;
  /** Périmètres réellement accordés, qui peuvent différer de ceux demandés. */
  scope: string;
}

export interface BrokerAuthorizationPort {
  /** URL vers laquelle envoyer le navigateur de l'utilisateur. */
  buildAuthorizationUrl(request: AuthorizationRequest): string;

  /** Échange le code d'autorisation contre un jeton d'accès. */
  exchangeCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<GrantedAuthorization>;
}

export interface BrokerProvider {
  getAccount(context: BrokerContext): Promise<BrokerAccount>;

  /** `null` si le symbole est inconnu du courtier. */
  getAsset(context: BrokerContext, symbol: string): Promise<BrokerAsset | null>;

  getClock(context: BrokerContext): Promise<MarketClock>;

  /**
   * Transmet un ordre en montant.
   *
   * Lève `ORDER_REJECTED` si le courtier le refuse (fonds, position, actif),
   * `BROKER_UNAUTHORIZED` si le jeton est refusé, et `BROKER_UNAVAILABLE` ou
   * `BROKER_RATE_LIMITED` quand l'issue est INCONNUE — l'ordre a pu partir.
   */
  placeNotionalOrder(
    context: BrokerContext,
    request: NotionalOrderRequest
  ): Promise<BrokerOrder>;

  getOrder(context: BrokerContext, externalId: string): Promise<BrokerOrder | null>;

  /**
   * Retrouve un ordre par la clé d'AMARA. C'est ce qui lève le doute après
   * une coupure réseau pendant la transmission.
   */
  findOrderByClientOrderId(
    context: BrokerContext,
    clientOrderId: string
  ): Promise<BrokerOrder | null>;

  /* --- Lecture du compte et données de marché --- */

  getPositions(context: BrokerContext): Promise<BrokerPosition[]>;

  /** Valeur du compte au fil de la période. */
  getPortfolioHistory(context: BrokerContext, range: HistoryRange): Promise<SeriesPoint[]>;

  /** Symboles inconnus du fournisseur : absents du résultat. */
  getSnapshots(context: BrokerContext, symbols: string[]): Promise<MarketSnapshot[]>;

  /** Clôtures sur la période, séance régulière seulement pour « 1J ». */
  getBars(context: BrokerContext, symbol: string, range: HistoryRange): Promise<SeriesPoint[]>;

  getNews(context: BrokerContext, symbols: string[], limit: number): Promise<NewsArticle[]>;
}
