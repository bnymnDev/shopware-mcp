import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShopwareMcpError } from "../src/errors.js";
import { createHostedApp, probeError, shopAddress } from "../src/hosted/app.js";
import { assertPublicUrl, __test as net } from "../src/hosted/net.js";
import { open, parseSecretKey, seal } from "../src/hosted/store.js";
import { mock } from "./helpers/shopware.js";

const SHOP = "https://shop.example";
const KEY_ID = "SWIAEXAMPLEEXAMPLEEXAMPLE";
const SECRET = "the-right-secret";
const dataDir = mkdtempSync(join(tmpdir(), "swmcp-hosted-"));
const secretKey = parseSecretKey(randomBytes(32).toString("hex"));
let base: string;
const shopCalls: string[] = [];

/** A Shopware shop as far as the hosted server talks to it. */
async function fakeShop(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  shopCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
  if (url.pathname === "/api/oauth/token") {
    const body = JSON.parse(String(init?.body)) as { client_id?: string; client_secret?: string };
    if (body.client_id !== KEY_ID || body.client_secret !== SECRET) {
      return Response.json(
        { errors: [{ status: "401", code: "4", detail: "Client authentication failed" }] },
        { status: 401 },
      );
    }
    return Response.json({ access_token: "shop-token", expires_in: 600, token_type: "Bearer" });
  }
  if (url.pathname === "/api/_info/version") return Response.json({ version: "6.7.4.0" });
  if (url.pathname === "/api/_info/config") return Response.json({ version: "6.7.4.0" });
  if (url.pathname.startsWith("/api/search/")) return Response.json({ total: 0, data: [] });
  return Response.json({ errors: [{ status: "404", code: "NOT_FOUND" }] }, { status: 404 });
}

let app: ReturnType<typeof createHostedApp>;

beforeAll(async () => {
  // Real loopback traffic: msw cannot pass a streamed response through its interceptor.
  mock.close();
  app = createHostedApp({
    publicUrl: "http://placeholder",
    dataDir,
    secretKey,
    allowPrivate: true,
    fetchImpl: fakeShop as never,
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  // The issuer is the server's own address; recreate it now that the port is known.
  await new Promise<void>((resolve) => app.close(() => resolve()));
  app = createHostedApp({
    publicUrl: base,
    dataDir,
    secretKey,
    allowPrivate: true,
    fetchImpl: fakeShop as never,
  });
  const port = Number(new URL(base).port);
  await new Promise<void>((resolve) => app.listen(port, "127.0.0.1", () => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
  redirect: "manual" as const,
});

const REDIRECT = "https://claude.example/api/mcp/auth_callback";

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Walk the consent page like a person: returns the redirect after submitting the keys. */
async function consent(clientId: string, challenge: string, secret = SECRET) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${base}/mcp`,
  });
  const page = await fetch(`${base}/authorize?${query}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("<strong>Claude</strong>");
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return fetch(
    `${base}/authorize`,
    form({ request, shop_url: `${SHOP}/admin/`, client_id: KEY_ID, client_secret: secret }),
  );
}

describe("hosted mode", () => {
  it("announces itself the way MCP clients discover OAuth", async () => {
    const unauthorized = await fetch(`${base}/mcp`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const server = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({
      issuer: base,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("connects a shop, hands out tokens, serves MCP and rotates the refresh token", async () => {
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const wrong = await consent(clientId, challenge, "a-wrong-secret");
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("did not accept these keys");

    const redirect = await consent(clientId, challenge);
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe(base);
    const code = location.searchParams.get("code") ?? "";

    const badVerifier = await fetch(
      `${base}/token`,
      form({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        code_verifier: "nope".repeat(12),
        redirect_uri: REDIRECT,
      }),
    );
    expect(badVerifier.status).toBe(400);
    // The code was used up by the failed attempt: a stolen code cannot be retried.
    const reused = await fetch(
      `${base}/token`,
      form({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
      }),
    );
    expect(((await reused.json()) as { error: string }).error).toBe("invalid_grant");

    const second = new URL((await consent(clientId, challenge)).headers.get("location") ?? "");
    const tokens = (await (
      await fetch(
        `${base}/token`,
        form({
          grant_type: "authorization_code",
          code: second.searchParams.get("code") ?? "",
          client_id: clientId,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
        }),
      )
    ).json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });

    const client = new Client({ name: "hosted-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("shop_pulse");
    // Hosted is read-only, whatever a client asks for.
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
    expect(shopCalls).toContain("GET /api/_info/version");

    const refreshed = (await (
      await fetch(
        `${base}/token`,
        form({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        }),
      )
    ).json()) as { access_token: string; refresh_token: string };
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const replay = await fetch(
      `${base}/token`,
      form({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }),
    );
    expect(replay.status).toBe(400);

    // The data file holds neither a token nor the shop's secret in the clear.
    const stored = readFileSync(join(dataDir, "hosted.json"), "utf8");
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(refreshed.refresh_token);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("https://shop.example");
  });

  it("never redirects to an address the client did not register", async () => {
    const clientId = await registerClient();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/cb",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const response = await fetch(`${base}/authorize?${query}`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses clients that are not public or redirect anywhere dangerous", async () => {
    const register = (body: unknown) =>
      fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await register({ redirect_uris: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await register({ redirect_uris: ["http://example.com/cb"] })).status).toBe(400);
    expect(
      (
        await register({
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "client_secret_basic",
        })
      ).status,
    ).toBe(400);
    expect((await register({ redirect_uris: ["http://127.0.0.1:33418/cb"] })).status).toBe(201);
  });
});

describe("hosted helpers", () => {
  it("seals credentials so only the key opens them", () => {
    const sealed = seal(secretKey, "secret");
    expect(open(secretKey, sealed)).toBe("secret");
    expect(() => open(parseSecretKey(randomBytes(32).toString("base64")), sealed)).toThrow();
    expect(() => parseSecretKey("short")).toThrow(/32 bytes/);
  });

  it("says in words why the keys could not be tried", () => {
    const shop = "https://shop.example";
    expect(
      probeError(new ShopwareMcpError(401, "4", "Client authentication failed"), shop),
    ).toContain("did not accept these keys");
    expect(probeError(new ShopwareMcpError(405, "HTTP_405", "<!doctype html>"), shop)).toBe(
      "No Shopware Admin API answered at https://shop.example/api. Check the shop address.",
    );
    expect(probeError(new ShopwareMcpError(504, "TIMEOUT", "slow"), shop)).toContain("in time");
    expect(probeError(new TypeError("fetch failed"), shop)).toContain("could not be reached");
  });

  it("cleans up a pasted shop address", () => {
    expect(shopAddress(" https://shop.example/admin/ ")).toBe("https://shop.example");
    expect(shopAddress("https://shop.example/api")).toBe("https://shop.example");
  });

  it("keeps private and loopback addresses out", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      "100.64.0.1",
    ]) {
      expect(net.privateAddress(address)).toBe(true);
    }
    for (const address of ["8.8.8.8", "185.199.108.153", "2a00:1450::1"]) {
      expect(net.privateAddress(address)).toBe(false);
    }
    await expect(assertPublicUrl("http://shop.example")).rejects.toThrow(/https/);
    await expect(assertPublicUrl("https://127.0.0.1")).rejects.toThrow(/not a public address/);
    await expect(assertPublicUrl("https://user:pw@shop.example")).rejects.toThrow(/credentials/);
  });
});
