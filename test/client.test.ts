import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenProvider } from "../src/client/auth.js";
import { ShopwareClient } from "../src/client/index.js";
import { ShopwareMcpError } from "../src/errors.js";
import { fixture, mock, requests, SHOP_URL, testConfig } from "./helpers/shopware.js";

const tokenRequests = () => requests.filter((r) => r.path === "/api/oauth/token");

describe("TokenProvider", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("caches the token and refreshes 60s before expiry", async () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const provider = new TokenProvider(testConfig());
    expect(await provider.getToken()).toBe("test-access-token");
    expect(await provider.getToken()).toBe("test-access-token");
    expect(tokenRequests()).toHaveLength(1);

    vi.setSystemTime(new Date("2024-01-01T00:08:59Z")); // 539s < 600 - 60
    await provider.getToken();
    expect(tokenRequests()).toHaveLength(1);

    vi.setSystemTime(new Date("2024-01-01T00:09:01Z")); // within the 60s margin
    await provider.getToken();
    expect(tokenRequests()).toHaveLength(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const provider = new TokenProvider(testConfig());
    await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);
    expect(tokenRequests()).toHaveLength(1);
  });

  it("sends client credentials as JSON and never logs them", async () => {
    const provider = new TokenProvider(testConfig());
    await provider.getToken();
    const [request] = tokenRequests();
    expect(request?.body).toEqual({
      grant_type: "client_credentials",
      client_id: "SWIATEST",
      client_secret: "secret",
    });
  });

  it("maps OAuth failures", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/oauth/token`, () =>
        HttpResponse.json(fixture("error-oauth"), { status: 401 }),
      ),
    );
    const provider = new TokenProvider(testConfig());
    await expect(provider.getToken()).rejects.toMatchObject({
      status: 401,
      code: "INVALID_CLIENT",
    });
  });
});

describe("ShopwareClient", () => {
  it("sends bearer auth and JSON accept headers", async () => {
    const client = new ShopwareClient(testConfig());
    await client.request("/api/_info/version");
    const request = requests.find((r) => r.path === "/api/_info/version");
    expect(request?.headers.authorization).toBe("Bearer test-access-token");
    expect(request?.headers.accept).toBe("application/json");
  });

  it("refreshes the token once on 401 and retries", async () => {
    let calls = 0;
    mock.use(
      http.get(`${SHOP_URL}/api/_info/version`, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ errors: [] }, { status: 401 });
        return HttpResponse.json({ version: "6.6.0.0" });
      }),
    );
    const client = new ShopwareClient(testConfig());
    const result = await client.request<{ version: string }>("/api/_info/version");
    expect(result.version).toBe("6.6.0.0");
    expect(calls).toBe(2);
    expect(tokenRequests()).toHaveLength(2);
  });

  it("gives up after one retry on repeated 401", async () => {
    mock.use(
      http.get(`${SHOP_URL}/api/_info/version`, () =>
        HttpResponse.json(
          {
            errors: [
              { code: "9", status: "401", detail: "The resource owner denied the request." },
            ],
          },
          { status: 401 },
        ),
      ),
    );
    const client = new ShopwareClient(testConfig());
    await expect(client.request("/api/_info/version")).rejects.toMatchObject({
      status: 401,
      code: "9",
    });
    expect(tokenRequests()).toHaveLength(2);
  });

  it("maps network failures", async () => {
    mock.use(http.get(`${SHOP_URL}/api/_info/version`, () => HttpResponse.error()));
    const client = new ShopwareClient(testConfig());
    await expect(client.request("/api/_info/version")).rejects.toMatchObject({
      status: 0,
      code: "NETWORK",
    });
  });

  it("parses search results with exact totals", async () => {
    const client = new ShopwareClient(testConfig());
    const result = await client.search("product", { limit: 2 });
    expect(result.total).toBe(42);
    expect(result.items).toHaveLength(2);
    const body = requests.find((r) => r.path === "/api/search/product")?.body as Record<
      string,
      unknown
    >;
    expect(body["total-count-mode"]).toBe(1);
  });

  it("throws NOT_FOUND when findById gets no hits", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/product`, () => HttpResponse.json({ total: 0, data: [] })),
    );
    const client = new ShopwareClient(testConfig());
    await expect(client.findById("product", "deadbeef")).rejects.toBeInstanceOf(ShopwareMcpError);
    await expect(client.findById("product", "deadbeef")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("caches currencies", async () => {
    const client = new ShopwareClient(testConfig());
    expect(await client.currencyCode("b7d2554b0ce847cd82f3ac9bd1c0dfca")).toBe("EUR");
    expect(await client.currencyCode("6d7e8f01020304050607080a0b0c0d0e")).toBe("USD");
    expect(await client.currencyCode("unknown")).toBeNull();
    expect(requests.filter((r) => r.path === "/api/search/currency")).toHaveLength(1);
  });
});
