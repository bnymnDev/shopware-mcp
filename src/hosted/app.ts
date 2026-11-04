import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FetchLike } from "../client/fetch.js";
import { ShopwareClient } from "../client/index.js";
import { type Config, DEFAULT_LIMIT, MAX_LIMIT } from "../config.js";
import { logger } from "../logger.js";
import { createServer } from "../server.js";
import type { ToolContext } from "../tools/types.js";
import { assertPublicUrl } from "./net.js";
import { consentPage, errorPage, homePage } from "./pages.js";
import { type ClientRecord, open, parseSecretKey, randomToken, Store, seal } from "./store.js";

export interface HostedOptions {
  /** The address people reach the server under, without a trailing slash. */
  publicUrl: string;
  dataDir: string;
  secretKey: Buffer;
  /** A folder whose files are served under / (the website). */
  siteDir?: string;
  /** Allow shops and client metadata on private addresses: tests and a self-hosted LAN only. */
  allowPrivate?: boolean;
  fetchImpl?: FetchLike;
  now?: () => number;
}

const SCOPE = "shop:read";
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 30 * 60_000;
const CLIENT_DOC_TTL_MS = 24 * 3600_000;
const MAX_BODY = 64 * 1024;

interface PendingRequest {
  client: ClientRecord;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
  expiresAt: number;
}

interface IssuedCode extends Omit<PendingRequest, "client" | "expiresAt"> {
  clientId: string;
  connectionId: string;
  expiresAt: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A redirect URI a client may register: https, a loopback http address, or an app's scheme. */
function redirectAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(url.protocol);
  } catch {
    return false;
  }
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "invalid_request", "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const body = await readBody(req);
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    const value = JSON.parse(body || "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  return Object.fromEntries(new URLSearchParams(body));
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
};

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...CORS,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** A file of the website, never a path outside its folder. */
function staticFile(dir: string, pathname: string): { body: Buffer; type: string } | null {
  const root = resolve(dir);
  let target = resolve(join(root, normalize(decodeURIComponent(pathname))));
  if (!target.startsWith(root)) return null;
  try {
    if (statSync(target).isDirectory()) target = join(target, "index.html");
    return {
      body: readFileSync(target),
      type: TYPES[extname(target)] ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

/** A simple sliding window per address, so nobody can try keys or register clients in bulk. */
class RateLimit {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) return false;
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

/** Normalises what people paste as their shop's address. */
export function shopAddress(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(admin|api)$/i, "")
    .replace(/\/+$/, "");
}

export function createHostedApp(options: HostedOptions): Server {
  const now = options.now ?? Date.now;
  const publicUrl = options.publicUrl.replace(/\/+$/, "");
  const resourceUrl = `${publicUrl}/mcp`;
  const store = new Store(options.dataDir);
  const pending = new Map<string, PendingRequest>();
  const codes = new Map<string, IssuedCode>();
  const contexts = new Map<string, { ctx: ToolContext; until: number }>();
  const limiter = new RateLimit(30, 60_000);
  const fetchImpl = options.fetchImpl;

  const sweep = setInterval(() => {
    const at = now();
    for (const [key, value] of pending) if (value.expiresAt <= at) pending.delete(key);
    for (const [key, value] of codes) if (value.expiresAt <= at) codes.delete(key);
    for (const [key, value] of contexts) if (value.until <= at) contexts.delete(key);
    store.sweep(at);
  }, 10 * 60_000);
  sweep.unref();

  const metadata = {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/authorize`,
    token_endpoint: `${publicUrl}/token`,
    registration_endpoint: `${publicUrl}/register`,
    revocation_endpoint: `${publicUrl}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
  };
  const resourceMetadata = {
    resource: resourceUrl,
    authorization_servers: [publicUrl],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "shopware-mcp",
  };

  /** A client by id: registered here, or a metadata document at an https URL (CIMD). */
  async function findClient(clientId: string): Promise<ClientRecord> {
    const known = store.client(clientId);
    const fresh = known && now() - Date.parse(known.createdAt) < CLIENT_DOC_TTL_MS;
    if (known && (fresh || !clientId.startsWith("https://"))) return known;
    if (!clientId.startsWith("https://")) {
      throw new HttpError(400, "invalid_client", "Unknown client");
    }
    const url = await assertPublicUrl(clientId, { allowPrivate: options.allowPrivate }).catch(
      (error: unknown) => {
        throw new HttpError(400, "invalid_client", `Client metadata: ${String(error)}`);
      },
    );
    const response = await (fetchImpl ?? fetch)(url.href, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    } as RequestInit).catch(() => null);
    const text = response?.ok ? await response.text() : "";
    if (!text || text.length > MAX_BODY) {
      throw new HttpError(400, "invalid_client", "Client metadata document not readable");
    }
    const document = JSON.parse(text) as {
      client_id?: string;
      client_name?: string;
      redirect_uris?: unknown;
    };
    const redirectUris = Array.isArray(document.redirect_uris)
      ? document.redirect_uris.filter(
          (uri): uri is string => typeof uri === "string" && redirectAllowed(uri),
        )
      : [];
    if (document.client_id !== clientId || redirectUris.length === 0) {
      throw new HttpError(400, "invalid_client", "Client metadata document does not match");
    }
    const record: ClientRecord = {
      clientId,
      clientName: String(document.client_name ?? url.hostname).slice(0, 100),
      redirectUris,
      createdAt: new Date(now()).toISOString(),
    };
    store.putClient(record);
    return record;
  }

  function contextFor(connectionId: string): ToolContext | null {
    const cached = contexts.get(connectionId);
    if (cached && cached.until > now()) return cached.ctx;
    const connection = store.connection(connectionId);
    if (!connection) return null;
    const { clientId, clientSecret } = JSON.parse(
      open(options.secretKey, connection.credentials),
    ) as {
      clientId: string;
      clientSecret: string;
    };
    const config: Config = {
      url: connection.shopUrl,
      clientId,
      clientSecret,
      allowWrite: false,
      extensions: true,
      defaultLimit: DEFAULT_LIMIT,
      maxLimit: MAX_LIMIT,
      timeoutMs: 30_000,
      maxWrites: 0,
      logLevel: "error",
    };
    const ctx = { client: new ShopwareClient(config, fetchImpl), config };
    contexts.set(connectionId, { ctx, until: now() + 15 * 60_000 });
    if (contexts.size > 1000) contexts.delete(contexts.keys().next().value as string);
    return ctx;
  }

  function issueTokens(record: { connectionId: string; clientId: string; resource: string }) {
    const access = randomToken();
    const refresh = randomToken();
    const at = now();
    store.issue("accessTokens", access, {
      ...record,
      scope: SCOPE,
      expiresAt: at + ACCESS_TTL * 1000,
    });
    store.issue("refreshTokens", refresh, {
      ...record,
      scope: SCOPE,
      expiresAt: at + REFRESH_TTL * 1000,
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: refresh,
      scope: SCOPE,
    };
  }

  async function authorizeGet(url: URL, res: ServerResponse) {
    const params = url.searchParams;
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    let client: ClientRecord;
    try {
      client = await findClient(clientId);
    } catch (error) {
      html(res, 400, errorPage("Unknown application", error instanceof Error ? error.message : ""));
      return;
    }
    // Never redirect to an address the client did not register: the error is shown here.
    if (!client.redirectUris.includes(redirectUri)) {
      html(
        res,
        400,
        errorPage("Unknown redirect", "This application did not register that address."),
      );
      return;
    }
    const fail = (error: string, description: string) => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      const state = params.get("state");
      if (state) target.searchParams.set("state", state);
      target.searchParams.set("iss", publicUrl);
      res.writeHead(302, { location: target.href });
      res.end();
    };
    if (params.get("response_type") !== "code") {
      fail("unsupported_response_type", "Only the authorization code flow is supported");
      return;
    }
    const challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !/^[\w-]{43,128}$/.test(challenge)) {
      fail("invalid_request", "PKCE with S256 is required");
      return;
    }
    const resource = params.get("resource") ?? resourceUrl;
    if (
      resource.replace(/\/+$/, "") !== resourceUrl &&
      resource.replace(/\/+$/, "") !== publicUrl
    ) {
      fail("invalid_target", `This server only issues tokens for ${resourceUrl}`);
      return;
    }
    const requestId = randomToken(24);
    pending.set(requestId, {
      client,
      redirectUri,
      codeChallenge: challenge,
      state: params.get("state"),
      resource: resourceUrl,
      expiresAt: now() + REQUEST_TTL_MS,
    });
    html(
      res,
      200,
      consentPage({
        requestId,
        clientName: client.clientName,
        redirectHost: new URL(redirectUri).host || new URL(redirectUri).protocol,
      }),
    );
  }

  async function authorizePost(req: IncomingMessage, res: ServerResponse) {
    const form = await readParams(req);
    const request = pending.get(form.request ?? "");
    if (!request || request.expiresAt <= now()) {
      html(res, 400, errorPage("Expired", "Start the connection again from your assistant."));
      return;
    }
    const shopUrl = shopAddress(form.shop_url ?? "");
    const again = (error: string) =>
      html(
        res,
        400,
        consentPage({
          requestId: form.request ?? "",
          clientName: request.client.clientName,
          redirectHost: new URL(request.redirectUri).host,
          shopUrl,
          error,
        }),
      );
    try {
      await assertPublicUrl(shopUrl, { allowPrivate: options.allowPrivate });
    } catch (error) {
      again(`Shop address: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const clientId = (form.client_id ?? "").trim();
    const clientSecret = (form.client_secret ?? "").trim();
    let version: string | null = null;
    try {
      const probe = new ShopwareClient(
        { url: shopUrl, clientId, clientSecret, timeoutMs: 15_000 },
        fetchImpl,
      );
      const info = await probe.request<{ version?: string }>("/api/_info/version");
      version = info.version ?? null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      again(
        /401|authentication/i.test(detail)
          ? "The shop did not accept these keys. Check the access key ID and the secret."
          : `The shop could not be reached: ${detail.slice(0, 160)}`,
      );
      return;
    }
    pending.delete(form.request ?? "");
    const connectionId = randomToken(16);
    const stamp = new Date(now()).toISOString();
    store.putConnection({
      id: connectionId,
      shopUrl,
      credentials: seal(options.secretKey, JSON.stringify({ clientId, clientSecret })),
      createdAt: stamp,
      lastUsedAt: stamp,
    });
    const code = randomToken();
    codes.set(code, {
      clientId: request.client.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      state: request.state,
      resource: request.resource,
      connectionId,
      expiresAt: now() + CODE_TTL_MS,
    });
    logger.info("shop connected", { shop: shopUrl, version, client: request.client.clientName });
    const target = new URL(request.redirectUri);
    target.searchParams.set("code", code);
    if (request.state) target.searchParams.set("state", request.state);
    target.searchParams.set("iss", publicUrl);
    res.writeHead(302, { location: target.href, "cache-control": "no-store" });
    res.end();
  }

  async function token(req: IncomingMessage, res: ServerResponse) {
    const params = await readParams(req);
    const error = (code: string, description: string, status = 400) =>
      json(res, status, { error: code, error_description: description });
    if (params.grant_type === "authorization_code") {
      const issued = codes.get(params.code ?? "");
      // A code is single-use, whatever happens next.
      codes.delete(params.code ?? "");
      if (!issued || issued.expiresAt <= now())
        return error("invalid_grant", "Unknown or expired code");
      if (params.client_id !== issued.clientId)
        return error("invalid_grant", "Code was issued to another client");
      if (params.redirect_uri && params.redirect_uri !== issued.redirectUri) {
        return error("invalid_grant", "redirect_uri does not match");
      }
      if (!params.code_verifier || !same(s256(params.code_verifier), issued.codeChallenge)) {
        return error("invalid_grant", "PKCE verification failed");
      }
      return json(res, 200, issueTokens(issued));
    }
    if (params.grant_type === "refresh_token") {
      const presented = params.refresh_token ?? "";
      const record = store.find("refreshTokens", presented, now());
      if (!record) return error("invalid_grant", "Unknown or expired refresh token");
      if (params.client_id && params.client_id !== record.clientId) {
        return error("invalid_grant", "Refresh token was issued to another client");
      }
      // Rotation: the old refresh token stops working the moment a new one is issued.
      store.revoke("refreshTokens", presented);
      return json(res, 200, issueTokens(record));
    }
    return error("unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  async function register(req: IncomingMessage, res: ServerResponse) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid_client_metadata", error_description: "Not JSON" });
    }
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (
      redirectUris.length === 0 ||
      redirectUris.length > 10 ||
      !redirectUris.every((uri) => typeof uri === "string" && redirectAllowed(uri))
    ) {
      return json(res, 400, {
        error: "invalid_redirect_uri",
        error_description: "Give 1 to 10 redirect URIs: https, loopback http or an app scheme",
      });
    }
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") {
      return json(res, 400, {
        error: "invalid_client_metadata",
        error_description: "Only public clients (token_endpoint_auth_method none) are supported",
      });
    }
    const record: ClientRecord = {
      clientId: randomToken(18),
      clientName: String(body.client_name ?? "An MCP client").slice(0, 100),
      redirectUris: redirectUris as string[],
      createdAt: new Date(now()).toISOString(),
    };
    store.putClient(record);
    return json(res, 201, {
      client_id: record.clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: record.clientName,
      redirect_uris: record.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  async function mcp(req: IncomingMessage, res: ServerResponse) {
    const challenge = (detail?: string) =>
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"` +
      (detail ? `, error="invalid_token", error_description="${detail}"` : "");
    const match = /^Bearer\s+(\S+)$/i.exec((req.headers.authorization ?? "").trim());
    if (!match?.[1]) {
      return json(
        res,
        401,
        { error: { status: 401, code: "UNAUTHORIZED", detail: "Connect your shop first" } },
        { "www-authenticate": challenge() },
      );
    }
    const record = store.find("accessTokens", match[1], now());
    const ctx = record ? contextFor(record.connectionId) : null;
    if (!record || !ctx) {
      return json(
        res,
        401,
        { error: { status: 401, code: "UNAUTHORIZED", detail: "Expired or unknown token" } },
        { "www-authenticate": challenge("The access token expired or is unknown") },
      );
    }
    store.touch(record.connectionId, now());
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    for (const [key, value] of Object.entries(CORS)) res.setHeader(key, value);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", publicUrl);
    const path = url.pathname;
    const address = req.socket.remoteAddress ?? "?";
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...CORS, "access-control-max-age": "86400" });
        res.end();
        return;
      }
      if (path === "/healthz") return json(res, 200, { ok: true });
      if (
        path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/openid-configuration"
      ) {
        return json(res, 200, metadata, { "cache-control": "public, max-age=3600" });
      }
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json(res, 200, resourceMetadata, { "cache-control": "public, max-age=3600" });
      }
      if (path === "/mcp") return await mcp(req, res);
      const limited =
        ["/register", "/token"].includes(path) || (path === "/authorize" && req.method === "POST");
      if (limited && !limiter.allow(address, now())) {
        return json(res, 429, {
          error: "slow_down",
          error_description: "Too many requests, wait a minute",
        });
      }
      if (path === "/authorize" && req.method === "GET") return await authorizeGet(url, res);
      if (path === "/authorize" && req.method === "POST") return await authorizePost(req, res);
      if (path === "/token" && req.method === "POST") return await token(req, res);
      if (path === "/register" && req.method === "POST") return await register(req, res);
      if (path === "/revoke" && req.method === "POST") {
        const params = await readParams(req);
        store.revoke("accessTokens", params.token ?? "");
        store.revoke("refreshTokens", params.token ?? "");
        return json(res, 200, {});
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const file = options.siteDir ? staticFile(options.siteDir, path) : null;
        if (file) {
          res.writeHead(200, {
            "content-type": file.type,
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
          });
          res.end(req.method === "HEAD" ? undefined : file.body);
          return;
        }
        if (path === "/") return html(res, 200, homePage(publicUrl));
      }
      return json(res, 404, { error: { status: 404, code: "NOT_FOUND", detail: "Not found" } });
    } catch (error) {
      if (error instanceof HttpError) {
        return json(res, error.status, { error: error.code, error_description: error.message });
      }
      logger.error("hosted request failed", {
        path,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) json(res, 500, { error: "server_error" });
    }
  });
}

/** Hosted settings from the environment; the error names what is missing. */
export function hostedOptionsFromEnv(env: NodeJS.ProcessEnv): HostedOptions {
  const publicUrl = env.SHOPWARE_MCP_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!publicUrl || !/^https?:\/\/[^/]+/.test(publicUrl)) {
    throw new Error("SHOPWARE_MCP_PUBLIC_URL is required, e.g. https://mcp.example.com");
  }
  return {
    publicUrl,
    secretKey: parseSecretKey(env.SHOPWARE_MCP_SECRET_KEY),
    dataDir: env.SHOPWARE_MCP_DATA_DIR?.trim() || "./data",
    ...(env.SHOPWARE_MCP_SITE_DIR?.trim() ? { siteDir: env.SHOPWARE_MCP_SITE_DIR.trim() } : {}),
    allowPrivate: env.SHOPWARE_MCP_ALLOW_PRIVATE_SHOPS === "true",
  };
}

export async function startHosted(
  options: HostedOptions,
  listen: { port: number; host: string },
): Promise<Server> {
  const app = createHostedApp(options);
  await new Promise<void>((done, fail) => {
    app.once("error", fail);
    app.listen(listen.port, listen.host, () => {
      app.off("error", fail);
      done();
    });
  });
  if (!options.publicUrl.startsWith("https://")) {
    logger.warn("SHOPWARE_MCP_PUBLIC_URL is not https: OAuth clients will refuse it outside tests");
  }
  logger.info("hosted mode listening", {
    url: `http://${listen.host}:${listen.port}`,
    public: options.publicUrl,
  });
  return app;
}
