import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HttpHandler, HttpResponse, http, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import { type ZodRawShape, z } from "zod";
import { ShopwareClient } from "../../src/client/index.js";
import { type Config, MAX_LIMIT } from "../../src/config.js";
import type { ToolContext, ToolDefinition } from "../../src/tools/types.js";

export const SHOP_URL = "https://shop.test";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const cache = new Map<string, unknown>();

export function fixture<T = unknown>(name: string): T {
  let value = cache.get(name);
  if (value === undefined) {
    value = JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8"));
    cache.set(name, value);
  }
  return structuredClone(value) as T;
}

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Every request that reached the mock Shopware, oldest first. Cleared after each test. */
export const requests: CapturedRequest[] = [];

async function capture(request: Request): Promise<CapturedRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let body: unknown;
  const text = await request.clone().text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const captured = { method: request.method, path: url.pathname + url.search, headers, body };
  requests.push(captured);
  return captured;
}

export const searchFixtures: Record<string, string> = {
  currency: "currencies",
  language: "language",
  "sales-channel": "sales-channels",
  product: "products-search",
  order: "orders-search",
  customer: "customers-search",
  "payment-method": "payment-method",
  category: "categories",
  promotion: "promotions",
  plugin: "plugins",
};

export function tokenHandler(): HttpHandler {
  return http.post(`${SHOP_URL}/api/oauth/token`, async ({ request }) => {
    await capture(request);
    return HttpResponse.json(fixture("token"));
  });
}

/** Route `POST /api/search/:entity` to a fixture, optionally overriding per entity. */
export function searchHandler(
  overrides: Record<string, string | (() => unknown)> = {},
): HttpHandler {
  return http.post(`${SHOP_URL}/api/search/:entity`, async ({ request, params }) => {
    await capture(request);
    const entity = String(params.entity);
    const override = overrides[entity];
    if (typeof override === "function") return HttpResponse.json(override() as JsonBodyType);
    const name = override ?? searchFixtures[entity];
    if (!name) {
      return HttpResponse.json(
        {
          errors: [
            {
              status: "404",
              code: "FRAMEWORK__ENTITY_NOT_FOUND",
              detail: `no fixture for ${entity}`,
            },
          ],
        },
        { status: 404 },
      );
    }
    return HttpResponse.json(fixture<JsonBodyType>(name));
  });
}

export function defaultHandlers(): HttpHandler[] {
  return [
    tokenHandler(),
    http.get(`${SHOP_URL}/api/_info/version`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json(fixture("info-version"));
    }),
    http.get(`${SHOP_URL}/api/_info/config`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json(fixture("info-config"));
    }),
    http.get(`${SHOP_URL}/api/_info/entity-schema.json`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json(fixture<JsonBodyType>("entity-schema"));
    }),
    http.get(`${SHOP_URL}/api/_action/extension/installed`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json(fixture("extensions-installed"));
    }),
    http.patch(`${SHOP_URL}/api/:entity/:id`, async ({ request }) => {
      await capture(request);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${SHOP_URL}/api/_action/order/:id/state/:transition`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ technicalName: "completed", name: "Done" });
    }),
    searchHandler(),
  ];
}

export const mock = setupServer(...defaultHandlers());

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: SHOP_URL,
    clientId: "SWIATEST",
    clientSecret: "secret",
    allowWrite: false,
    extensions: false,
    defaultLimit: 20,
    maxLimit: MAX_LIMIT,
    logLevel: "error",
    ...overrides,
  };
}

export function createContext(overrides: Partial<Config> = {}): ToolContext {
  const config = testConfig(overrides);
  return { client: new ShopwareClient(config), config };
}

export function searchRequests(entity: string): CapturedRequest[] {
  return requests.filter((r) => r.method === "POST" && r.path === `/api/search/${entity}`);
}

export function lastSearch(entity: string): CapturedRequest {
  const found = searchRequests(entity).at(-1);
  if (!found) throw new Error(`no search request for ${entity}`);
  return found;
}

export function writeRequests(): CapturedRequest[] {
  return requests.filter(
    (r) =>
      r.method === "PATCH" ||
      (r.method === "POST" && !r.path.startsWith("/api/search/") && r.path !== "/api/oauth/token"),
  );
}

/** Call a tool the way the MCP server does: validate/default the input with zod, then run it. */
export async function invoke<Shape extends ZodRawShape, Result>(
  tool: ToolDefinition<Shape, Result>,
  input: z.input<z.ZodObject<Shape>>,
  ctx: ToolContext,
): Promise<Result> {
  const parsed = z.object(tool.inputSchema).parse(input) as z.output<z.ZodObject<Shape>>;
  return tool.handler(parsed, ctx);
}
