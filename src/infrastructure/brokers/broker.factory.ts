import type { BrokerConfig } from "@/config/broker.config.js";
import type {
  BrokerAuthorizationPort,
  BrokerProvider
} from "@/ports/broker.port.js";
import { AlpacaOAuth } from "./alpaca/alpaca.oauth.js";
import {
  AlpacaTradingProvider,
  apiKeyCredential
} from "./alpaca/alpaca.trading.provider.js";

/** Identifiant opaque du compte partagé, à placer dans `BrokerContext`. */
export function sharedAccountCredential(
  shared: NonNullable<BrokerConfig["sharedAccount"]>
): string {
  return apiKeyCredential(shared.keyId, shared.secret);
}

export interface BrokerAdapters {
  authorization: BrokerAuthorizationPort;
  provider: BrokerProvider;
}

/**
 * Assemble les adaptateurs du courtier.
 *
 * Seul endroit du backend qui nomme Alpaca. Le passage à Alpaca Broker API,
 * ou l'ajout d'un fournisseur factice pour les tests, se fait ici — les
 * services ne voient que les ports.
 */
export function createBrokerAdapters(config: BrokerConfig): BrokerAdapters {
  return {
    authorization: new AlpacaOAuth(config),
    provider: new AlpacaTradingProvider(config)
  };
}
