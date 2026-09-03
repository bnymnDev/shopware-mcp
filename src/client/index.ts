import type { Config } from "../config.js";
import { fromHttpResponse, networkError, notFound, ShopwareMcpError } from "../errors.js";
import { logger } from "../logger.js";
import { NAME, VERSION } from "../version.js";
import { TokenProvider } from "./auth.js";
import { type Criteria, equals } from "./criteria.js";
import { defaultFetch, type FetchLike, parseBody } from "./fetch.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Raw = Record<string, unknown>;

export interface SearchResult<T = Raw> {
  total: number;
  items: T[];
  aggregations: Record<string, unknown>;
}

export interface CurrencyInfo {
  id: string;
  isoCode: string;
  symbol: string | null;
  name: string | null;
}

/** Identifies this client in shop access logs; helps operators see which integration calls them. */
export const USER_AGENT = `${NAME}/${VERSION} (+https://github.com/bnymnDev/shopware-mcp)`;

/** Status codes that are worth exactly one retry after a short pause. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5_000;

/** Headers to resolve variant/parent inheritance for product reads. */
export const INHERITANCE_HEADERS: Record<string, string> = { "sw-inheritance": "true" };

/**
 * Thin Shopware 6 Admin API client: bearer auth with one refresh+retry on 401, JSON in/out,
 * and Criteria search via `POST /api/search/<entity>`.
 */
export class ShopwareClient {
  readonly baseUrl: string;
  private readonly auth: TokenProvider;
  private currencyCache: Promise<Map<string, CurrencyInfo>> | undefined;
  private schemaCache: Promise<Record<string, Raw>> | undefined;
  private readonly languageId: string | undefined;

  constructor(
    config: Pick<Config, "url" | "clientId" | "clientSecret"> & Partial<Pick<Config, "languageId">>,
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.baseUrl = config.url;
    this.languageId = config.languageId;
    this.auth = new TokenProvider(config, fetchImpl);
  }

  url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.send<T>(path, options, { authRetried: false, transientRetried: false });
  }

  private async send<T>(
    path: string,
    options: RequestOptions,
    state: { authRetried: boolean; transientRetried: boolean },
  ): Promise<T> {
    const token = await this.auth.getToken();
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": USER_AGENT,
      authorization: `Bearer ${token}`,
      ...(this.languageId ? { "sw-language-id": this.languageId } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...options.headers,
    };
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (cause) {
      logger.debug("request failed (network)", { method, path });
      throw networkError(cause);
    }
    logger.debug("request", { method, path, status: response.status, ms: Date.now() - startedAt });

    if (response.status === 401 && !state.authRetried) {
      // Drain the body so the connection is released, then refresh the token once and retry.
      await response.text().catch(() => undefined);
      this.auth.invalidate();
      return this.send<T>(path, options, { ...state, authRetried: true });
    }
    if (TRANSIENT_STATUSES.has(response.status) && !state.transientRetried) {
      await response.text().catch(() => undefined);
      const delay = retryDelayMs(response.headers.get("retry-after"));
      logger.debug("transient error, retrying once", { status: response.status, delay });
      await this.sleep(delay);
      return this.send<T>(path, options, { ...state, transientRetried: true });
    }
    const body = await parseBody(response);
    if (!response.ok) throw fromHttpResponse(response.status, body);
    return body as T;
  }

  /** Criteria search. Always requests an exact total. */
  async search<T = Raw>(
    entity: string,
    criteria: Criteria,
    headers?: Record<string, string>,
  ): Promise<SearchResult<T>> {
    const body = await this.request<Raw | undefined>(`/api/search/${entity}`, {
      method: "POST",
      body: { "total-count-mode": 1, ...criteria },
      headers,
    });
    const data = Array.isArray(body?.data) ? (body.data as T[]) : [];
    const total = typeof body?.total === "number" ? body.total : data.length;
    const aggregations =
      body?.aggregations && typeof body.aggregations === "object"
        ? (body.aggregations as Record<string, unknown>)
        : {};
    return { total, items: data, aggregations };
  }

  /** Search a single entity by ID with the given associations; throws NOT_FOUND if absent. */
  async findById<T = Raw>(
    entity: string,
    id: string,
    criteria: Omit<Criteria, "filter" | "limit" | "page"> = {},
    headers?: Record<string, string>,
  ): Promise<T> {
    const result = await this.search<T>(
      entity,
      { ...criteria, filter: [equals("id", id)], limit: 1, page: 1 },
      headers,
    );
    const item = result.items[0];
    if (!item) throw notFound(entity, id);
    return item;
  }

  /** Search a single entity by an arbitrary equals-filter; throws NOT_FOUND if absent. */
  async findOne<T = Raw>(
    entity: string,
    field: string,
    value: string,
    criteria: Omit<Criteria, "filter" | "limit" | "page"> = {},
    headers?: Record<string, string>,
  ): Promise<T> {
    const result = await this.search<T>(
      entity,
      { ...criteria, filter: [equals(field, value)], limit: 1, page: 1 },
      headers,
    );
    const item = result.items[0];
    if (!item) throw notFound(entity, `${field}=${value}`);
    return item;
  }

  /** All currencies, cached for the lifetime of the client. */
  currencies(): Promise<Map<string, CurrencyInfo>> {
    if (!this.currencyCache) {
      this.currencyCache = this.loadCurrencies().catch((error: unknown) => {
        this.currencyCache = undefined;
        throw error;
      });
    }
    return this.currencyCache;
  }

  private async loadCurrencies(): Promise<Map<string, CurrencyInfo>> {
    const result = await this.search<Raw>("currency", { limit: 50, page: 1 });
    const map = new Map<string, CurrencyInfo>();
    for (const currency of result.items) {
      const id = typeof currency.id === "string" ? currency.id : undefined;
      const isoCode = typeof currency.isoCode === "string" ? currency.isoCode : undefined;
      if (!id || !isoCode) continue;
      map.set(id, {
        id,
        isoCode,
        symbol: typeof currency.symbol === "string" ? currency.symbol : null,
        name: translatedName(currency),
      });
    }
    return map;
  }

  /**
   * Entity schema from `/api/_info/entity-schema.json`, cached for the lifetime of the client.
   * Keys are snake_case entity names (e.g. `order_line_item`).
   */
  entitySchema(): Promise<Record<string, Raw>> {
    if (!this.schemaCache) {
      this.schemaCache = this.request<Record<string, Raw>>("/api/_info/entity-schema.json").catch(
        (error: unknown) => {
          this.schemaCache = undefined;
          throw error;
        },
      );
    }
    return this.schemaCache;
  }

  async currencyCode(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    try {
      return (await this.currencies()).get(id)?.isoCode ?? null;
    } catch (error) {
      if (error instanceof ShopwareMcpError) {
        logger.debug("currency lookup failed", { code: error.code });
        return null;
      }
      throw error;
    }
  }
}

function retryDelayMs(retryAfter: string | null): number {
  if (!retryAfter) return 500;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  const at = Date.parse(retryAfter);
  if (Number.isNaN(at)) return 500;
  return Math.max(0, Math.min(at - Date.now(), MAX_RETRY_DELAY_MS));
}

function translatedName(entity: Raw): string | null {
  const translated = entity.translated;
  if (translated && typeof translated === "object") {
    const name = (translated as Raw).name;
    if (typeof name === "string") return name;
  }
  return typeof entity.name === "string" ? entity.name : null;
}
