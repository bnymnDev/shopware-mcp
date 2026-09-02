import { fromHttpResponse, networkError, ShopwareMcpError } from "../errors.js";
import { logger } from "../logger.js";
import { defaultFetch, type FetchLike, parseBody } from "./fetch.js";

/** Refresh this long before the token actually expires. */
const REFRESH_MARGIN_MS = 60_000;
const FALLBACK_EXPIRES_IN_S = 600;

export interface AuthConfig {
  url: string;
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * OAuth2 client-credentials token provider for the Shopware Admin API.
 * Tokens are cached in memory and refreshed 60 s before expiry. Concurrent callers share one
 * in-flight request. Secrets are never logged.
 */
export class TokenProvider {
  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly config: AuthConfig,
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > this.now()) {
      return this.cached.token;
    }
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  /** Drop the cached token, e.g. after a 401. The next `getToken()` fetches a fresh one. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    const url = `${this.config.url}/api/oauth/token`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
    } catch (cause) {
      logger.debug("token request failed (network)");
      throw networkError(cause);
    }
    const body = await parseBody(response);
    if (!response.ok) {
      logger.debug("token request rejected", { status: response.status });
      throw fromHttpResponse(response.status, body);
    }
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const token = record.access_token;
    if (typeof token !== "string" || !token) {
      throw new ShopwareMcpError(response.status, "AUTH", "Token response lacks access_token");
    }
    const expiresIn =
      typeof record.expires_in === "number" && record.expires_in > 0
        ? record.expires_in
        : FALLBACK_EXPIRES_IN_S;
    this.cached = { token, expiresAt: this.now() + expiresIn * 1000 };
    logger.debug("access token acquired", { expiresIn });
    return token;
  }
}
