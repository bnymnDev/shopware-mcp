import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { detectExtensionTools, extensionPacks } from "../src/extensions/index.js";
import {
  merqoAbandonedCarts,
  merqoEinvoiceInbox,
  merqoHealth,
  merqoReturns,
} from "../src/extensions/merqo.js";
import { createServer, extensionsReady } from "../src/server.js";
import {
  createContext,
  fixture,
  invoke,
  lastSearch,
  mock,
  SHOP_URL,
  searchHandler,
  searchRequests,
} from "./helpers/shopware.js";

const merqoShop = () => searchHandler({ plugin: "merqo-plugins" });
const hubHandler = () =>
  http.get(`${SHOP_URL}/api/_action/merqo-hub/status`, async () =>
    HttpResponse.json(fixture("merqo-hub-status")),
  );

describe("extension detection", () => {
  it("finds nothing in a shop without the extensions", async () => {
    const ctx = createContext({ extensions: true });
    expect(await detectExtensionTools(ctx)).toEqual([]);
  });

  it("registers only the tools whose plugins are active", async () => {
    mock.use(merqoShop());
    const detected = await detectExtensionTools(createContext({ extensions: true }));
    expect(detected.map((entry) => entry.tool.name).sort()).toEqual([
      "merqo_einvoice_inbox",
      "merqo_health",
      "merqo_returns_search",
    ]);
    expect(detected.every((entry) => entry.packId === "merqo")).toBe(true);
    // MerqoRescue is not installed, so its tool stays absent.
    expect(detected.map((entry) => entry.tool.name)).not.toContain("merqo_abandoned_carts");
    expect(lastSearch("plugin").body).toMatchObject({
      filter: [{ type: "equals", field: "active", value: true }],
      includes: { plugin: ["name", "active"] },
    });
  });

  it("is disabled by configuration and then makes no request", async () => {
    mock.use(merqoShop());
    expect(await detectExtensionTools(createContext({ extensions: false }))).toEqual([]);
    expect(searchRequests("plugin")).toHaveLength(0);
  });

  it("asks the shop only once per client", async () => {
    mock.use(merqoShop());
    const ctx = createContext({ extensions: true });
    await Promise.all([detectExtensionTools(ctx), detectExtensionTools(ctx)]);
    await detectExtensionTools(ctx);
    expect(searchRequests("plugin")).toHaveLength(1);
  });

  it("degrades to the core tool set when the shop refuses the lookup", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/plugin`, () =>
        HttpResponse.json(
          { errors: [{ code: "FRAMEWORK__MISSING_PRIVILEGE", detail: "no" }] },
          { status: 403 },
        ),
      ),
    );
    expect(await detectExtensionTools(createContext({ extensions: true }))).toEqual([]);
  });

  it("keeps every pack additive and namespaced", () => {
    for (const pack of extensionPacks) {
      for (const entry of pack.tools) {
        expect(entry.requires.length).toBeGreaterThan(0);
        expect(entry.tool.name.startsWith(`${pack.id}_`)).toBe(true);
        expect(entry.tool.write).toBe(false);
      }
    }
  });
});

describe("server with plugin-aware tools", () => {
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  async function connect(extensions: boolean): Promise<Client> {
    const server = createServer(createContext({ extensions }));
    await extensionsReady(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    clients.push(client);
    return client;
  }

  it("exposes the extra tools once detected", async () => {
    mock.use(merqoShop(), hubHandler());
    const client = await connect(true);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("merqo_health");
    expect(names).toContain("shop_audit");
    const result = await client.callTool({ name: "merqo_health", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ shopwareVersion: "6.7.2.2" });
  });

  it("says nothing about any vendor in a shop without them", async () => {
    const client = await connect(true);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith("merqo_"))).toBe(false);
    expect(JSON.stringify(listed).toLowerCase()).not.toContain("merqo");
  });
});

describe("merqo tools", () => {
  const ctx = createContext({ extensions: true });

  it("merqo_health summarises the hub status and filters by status", async () => {
    mock.use(hubHandler());
    const health = await invoke(merqoHealth, {}, ctx);
    expect(health).toMatchObject({
      shopwareVersion: "6.7.2.2",
      phpVersion: "8.3.14",
      summary: {
        compliance: { ok: 1, warn: 1, critical: 0, neutral: 1 },
        operations: { ok: 1, warn: 1, critical: 1, neutral: 0 },
      },
    });
    // The hub keys its plugin map by name, exactly as a real 6.7 shop returns it.
    expect(health.plugins).toEqual([
      { name: "MerqoHub", version: "0.1.0", active: true },
      { name: "MerqoVault", version: "0.2.0", active: true },
      { name: "MerqoMigrate", version: "0.1.0", active: false },
    ]);
    expect(health.operations[0]).toEqual({
      id: "resilience",
      status: "critical",
      plugin: null,
      details: { removedServices: ["Merqo\\Vault\\Mail\\Fetcher"] },
    });

    const urgent = await invoke(merqoHealth, { status: ["critical", "warn"] }, ctx);
    expect(urgent.compliance.map((check) => check.id)).toEqual(["vault"]);
    expect(urgent.operations.map((check) => check.id)).toEqual(["resilience", "twoFactor"]);
    expect(urgent.summary.compliance.ok).toBe(1);
  });

  it("merqo_einvoice_inbox filters by verdict and never returns the stored file", async () => {
    const original = "JVBERi0xLjQK".repeat(500);
    mock.use(
      searchHandler({
        "merqo-vault-document": () => ({
          total: 1,
          data: [
            {
              id: "eeee000000000000000000000000v001",
              filename: "supplier-2026-09.xml",
              verdict: "error",
              flavor: "xrechnung",
              invoiceNumber: "RE-2026-0042",
              issueDate: "2026-09-01",
              sellerName: "Lieferant GmbH",
              buyerName: "Mein Shop",
              currency: "EUR",
              grossTotalCents: 238000,
              findings: [{ rule: "BR-DE-15", message: "Leitweg-ID missing" }],
              source: "mail",
              original,
              createdAt: "2026-09-01T06:00:00.000+00:00",
              _uniqueIdentifier: "eeee000000000000000000000000v001",
            },
          ],
        }),
      }),
    );
    const page = await invoke(merqoEinvoiceInbox, { verdict: "error", limit: 5 }, ctx);
    expect(lastSearch("merqo-vault-document").body).toMatchObject({
      limit: 5,
      filter: [{ type: "equals", field: "verdict", value: "error" }],
      sort: [{ field: "createdAt", order: "DESC" }],
    });
    expect(page.items[0]).toEqual({
      id: "eeee000000000000000000000000v001",
      filename: "supplier-2026-09.xml",
      verdict: "error",
      flavor: "xrechnung",
      invoiceNumber: "RE-2026-0042",
      issueDate: "2026-09-01",
      seller: "Lieferant GmbH",
      buyer: "Mein Shop",
      currency: "EUR",
      grossTotal: 2380,
      findings: [{ rule: "BR-DE-15", message: "Leitweg-ID missing" }],
      source: "mail",
      receivedAt: "2026-09-01T06:00:00.000+00:00",
    });
    expect(JSON.stringify(page)).not.toContain("JVBERi0xLjQK");
  });

  it("merqo_returns_search maps line items and the order number", async () => {
    mock.use(searchHandler({ "merqo-return": "merqo-returns" }));
    const page = await invoke(merqoReturns, { status: "requested" }, ctx);
    expect(lastSearch("merqo-return").body).toMatchObject({
      filter: [{ type: "equals", field: "status", value: "requested" }],
      associations: { lineItems: {}, order: {} },
    });
    expect(page.items[0]).toMatchObject({
      status: "requested",
      orderNumber: "10042",
      refundTotal: 119,
      lineItems: [{ quantity: 1, reason: "damaged", condition: "unused" }],
    });
    expect(JSON.stringify(page)).not.toContain("_uniqueIdentifier");
  });

  it("merqo_abandoned_carts keeps the cart token out of the answer", async () => {
    mock.use(searchHandler({ "merqo-cart-snapshot": "merqo-carts" }));
    const page = await invoke(merqoAbandonedCarts, { state: "abandoned" }, ctx);
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({
      email: "max@example.com",
      amount: 149.99,
      state: "abandoned",
      lineItems: [
        {
          label: "Aerodynamic Bronze Bag",
          type: "product",
          productId: "a1b2c3d4e5f60718293a4b5c6d7e8f01",
          quantity: 1,
          unitPrice: 119,
          totalPrice: 119,
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("SECRETCARTTOKEN");
  });

  it("surfaces shop errors in the compact shape", async () => {
    mock.use(
      http.get(`${SHOP_URL}/api/_action/merqo-hub/status`, () =>
        HttpResponse.json({ errors: [{ code: "X", detail: "boom" }] }, { status: 500 }),
      ),
    );
    await expect(invoke(merqoHealth, {}, ctx)).rejects.toMatchObject({
      status: 500,
      code: "X",
    });
  });
});
