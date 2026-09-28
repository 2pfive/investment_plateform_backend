import { z } from "zod";
import type { BrokerConfig } from "@/config/broker.config.js";
import type {
  AuthorizationRequest,
  BrokerAuthorizationPort,
  GrantedAuthorization
} from "@/ports/broker.port.js";
import { BrokerError } from "@/ports/broker.errors.js";
import { alpacaHttp, toBrokerError } from "./alpaca.http.js";

/**
 * Réponse du point d'échange, telle que documentée par Alpaca.
 *
 * Ni `expires_in` ni `refresh_token` : ils n'existent pas. Un champ
 * supplémentaire serait ignoré plutôt que rejeté — le jour où Alpaca en
 * ajoute un, l'échange ne doit pas casser.
 */
const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string().default("")
});

export class AlpacaOAuth implements BrokerAuthorizationPort {
  constructor(private readonly config: BrokerConfig) {}

  buildAuthorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(this.config.authorizeUrl);

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("state", request.state);
    url.searchParams.set("scope", request.scopes);
    // Toujours explicite : sans `env`, Alpaca propose paper ET live, et
    // l'utilisateur pourrait autoriser l'autre environnement que celui que
    // la connexion enregistre.
    url.searchParams.set("env", request.environment.toLowerCase());

    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<GrantedAuthorization> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri
    });

    let data: unknown;

    try {
      const response = await alpacaHttp.post(this.config.tokenUrl, body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      data = response.data;
    } catch (error) {
      const mapped = toBrokerError(error, "échange du code d'autorisation");

      // Un code refusé n'est pas un jeton révoqué : il a expiré, ou a déjà
      // servi. Le message doit orienter vers une nouvelle tentative.
      if (mapped.code === "BROKER_UNAUTHORIZED" || mapped.code === "BROKER_REQUEST_FAILED") {
        throw new BrokerError(
          "BROKER_REQUEST_FAILED",
          "L’autorisation n’a pas pu être finalisée. Relancez la connexion.",
          502
        );
      }

      throw mapped;
    }

    const parsed = tokenResponse.safeParse(data);

    if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
      console.warn("[alpaca] réponse d'échange de code inattendue");
      throw new BrokerError(
        "BROKER_REQUEST_FAILED",
        "Réponse inattendue d’Alpaca lors de la connexion.",
        502
      );
    }

    return {
      accessToken: parsed.data.access_token,
      scope: parsed.data.scope
    };
  }
}
