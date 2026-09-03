import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { shopAudit } from "../src/tools/audit.js";
import { entitySchema, entitySearch, scrub } from "../src/tools/entities.js";
import { salesReport } from "../src/tools/reports.js";
import {
  createContext,
  invoke,
  lastSearch,
  mock,
  requests,
  SHOP_URL,
  searchHandler,
  searchRequests,
} from "./helpers/shopware.js";

const ctx = createContext();
type Body = Record<string, unknown>;

describe("sales_report", () => {
  it("aggregates orders and line items and resolves top products", async () => {
    mock.use(
      searchHandler({
        order: "order-aggregations",
        "order-line-item": "line-item-aggregations",
        product: "products-search",
      }),
    );
    const report = await invoke(
      salesReport,
      { from: "2024-06-01", to: "2024-06-30", interval: "day" },
      ctx,
    );
    const orderBody = lastSearch("order").body as Body;
    expect(orderBody.filter).toEqual([
      {
        type: "range",
        field: "orderDateTime",
        parameters: { gte: "2024-06-01T00:00:00.000Z", lte: "2024-06-30T00:00:00.000Z" },
      },
      {
        type: "not",
        operator: "and",
        queries: [{ type: "equals", field: "stateMachineState.technicalName", value: "cancelled" }],
      },
    ]);
    expect((orderBody.aggregations as unknown[]).length).toBe(10);
    expect(lastSearch("order-line-item").body).toMatchObject({
      aggregations: [
        expect.objectContaining({
          name: "topByOrders",
          type: "terms",
          field: "productId",
          limit: 10,
        }),
        expect.objectContaining({ name: "topRevenue" }),
      ],
    });
    expect(lastSearch("product").body).toMatchObject({
      filter: [
        {
          type: "equalsAny",
          field: "id",
          value: ["a1b2c3d4e5f60718293a4b5c6d7e8f01", "b2c3d4e5f60718293a4b5c6d7e8f0102"],
        },
      ],
    });

    expect(report.totals).toMatchObject({
      orders: 3,
      revenueGross: 449.97,
      revenueNet: 378.13,
      shipping: 14.97,
      averageOrderValue: 149.99,
    });
    expect(report.revenueByCurrency).toEqual([{ currency: "EUR", orders: 3, revenue: 449.97 }]);
    expect(report.revenueBySalesChannel).toEqual([
      { salesChannel: "Storefront", orders: 3, revenue: 449.97 },
    ]);
    expect(report.ordersByState).toEqual([
      { key: "in_progress", orders: 2 },
      { key: "completed", orders: 1 },
    ]);
    expect(report.timeline).toEqual([
      { bucket: "2024-06-01 00:00:00", orders: 2, revenue: 299.98 },
      { bucket: "2024-06-02 00:00:00", orders: 1, revenue: 149.99 },
    ]);
    expect(report.topProducts[0]).toEqual({
      productId: "a1b2c3d4e5f60718293a4b5c6d7e8f01",
      productNumber: "SW10001",
      name: "Aerodynamic Bronze Bag",
      ordersContaining: 3,
      quantity: 5,
      revenue: 595,
    });
  });

  it("applies sales channel filter, keeps cancelled orders on request and defaults the period", async () => {
    mock.use(
      searchHandler({
        order: "order-aggregations",
        "order-line-item": () => ({ total: 0, data: [], aggregations: {} }),
      }),
    );
    const report = await invoke(
      salesReport,
      {
        salesChannelId: "3a4b5c6d7e8f01020304050607080a0b",
        excludeCancelled: false,
        interval: "month",
      },
      ctx,
    );
    const body = lastSearch("order").body as Body;
    const filters = body.filter as Body[];
    expect(filters).toHaveLength(2);
    expect(filters[1]).toEqual({
      type: "equals",
      field: "salesChannelId",
      value: "3a4b5c6d7e8f01020304050607080a0b",
    });
    expect(report.period.interval).toBe("month");
    expect(new Date(report.period.to).getTime()).toBeGreaterThan(
      new Date(report.period.from).getTime(),
    );
    expect(report.topProducts).toEqual([]);
    expect(searchRequests("product")).toHaveLength(0);
  });

  it("rejects inverted periods", async () => {
    await expect(
      invoke(salesReport, { from: "2024-07-01", to: "2024-06-01" }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("shop_audit", () => {
  it("runs every check and prioritises findings", async () => {
    const audit = await invoke(shopAudit, { stuckOrderDays: 14, lowStockThreshold: 3 }, ctx);
    expect(audit.summary).toMatchObject({ checksRun: 8, healthy: false });
    expect(audit.shop).toMatchObject({ version: "6.6.10.3", edition: "Community" });
    const ids = audit.findings.map((finding) => finding.id);
    expect(ids[0]).toBe("orders_paid_not_shipped");
    expect(ids).toContain("plugins_outdated");
    expect(audit.findings.map((finding) => finding.severity)).toEqual(
      [...audit.findings.map((finding) => finding.severity)].sort((a, b) => {
        const order = { critical: 0, warning: 1, info: 2 };
        return order[a] - order[b];
      }),
    );
    const stuck = audit.findings.find((finding) => finding.id === "orders_paid_not_shipped");
    expect(stuck).toMatchObject({ severity: "critical", count: 3, hint: expect.any(String) });
    expect(stuck?.items[0]).toMatchObject({ orderNumber: "10042", paymentState: "paid" });

    const orderSearches = searchRequests("order");
    expect(orderSearches).toHaveLength(2);
    const filters = orderSearches[0]?.body as Body;
    expect(JSON.stringify(filters.filter)).toContain('"paid"');
    expect(JSON.stringify(filters.filter)).toContain('"lt"');
    const lowStock = searchRequests("product").find((request) =>
      JSON.stringify(request.body).includes('"lt":3'),
    );
    expect(lowStock).toBeDefined();
    expect(lowStock?.headers["sw-inheritance"]).toBe("true");
    expect(audit.warnings).toBeUndefined();
  });

  it("reports healthy when nothing is found and records skipped checks", async () => {
    mock.use(
      searchHandler({
        order: () => ({ total: 0, data: [] }),
        product: () => ({ total: 0, data: [] }),
        promotion: () => ({ total: 0, data: [] }),
        "sales-channel": () => ({ total: 0, data: [] }),
        plugin: () => ({ total: 0, data: [] }),
      }),
      http.get(`${SHOP_URL}/api/_action/extension/installed`, () => HttpResponse.json([])),
    );
    const audit = await invoke(shopAudit, {}, ctx);
    expect(audit.findings).toEqual([]);
    expect(audit.summary.healthy).toBe(true);

    mock.use(
      http.post(`${SHOP_URL}/api/search/promotion`, () =>
        HttpResponse.json(
          { errors: [{ code: "FRAMEWORK__MISSING_PRIVILEGE", detail: "x" }] },
          { status: 403 },
        ),
      ),
    );
    const degraded = await invoke(shopAudit, {}, ctx);
    expect(degraded.warnings?.[0]).toContain("promotions_expired_active skipped");
    expect(degraded.summary.checksRun).toBe(7);
  });
});

describe("entity_search", () => {
  it("searches arbitrary entities and scrubs noise", async () => {
    mock.use(searchHandler({ "product-manufacturer": "manufacturers" }));
    const result = await invoke(
      entitySearch,
      {
        entity: "product_manufacturer",
        filter: [{ type: "contains", field: "name", value: "Ac" }],
        associations: ["media"],
      },
      ctx,
    );
    expect(lastSearch("product-manufacturer").body).toMatchObject({
      filter: [{ type: "contains", field: "name", value: "Ac" }],
      associations: { media: {} },
      limit: 20,
    });
    expect(result).toMatchObject({ entity: "product_manufacturer", total: 1, page: 1, limit: 20 });
    expect(result.items[0]).toEqual({
      id: "e5f60718293a4b5c6d7e8f0102030405",
      name: "Acme",
      translated: { name: "Acme" },
      link: "https://acme.example",
      media: { id: "c0ffee00000000000000000000000009", url: "https://shop.test/media/acme.png" },
    });
  });

  it("maps fields to includes and strips credentials from customers and sales channels", async () => {
    await invoke(entitySearch, { entity: "customer", fields: ["email", "password"] }, ctx);
    expect(lastSearch("customer").body).toMatchObject({
      includes: { customer: ["id", "email", "password"] },
    });
    const customers = await invoke(entitySearch, { entity: "customer" }, ctx);
    expect(JSON.stringify(customers)).not.toContain("$2y$");
    const channels = await invoke(entitySearch, { entity: "sales-channel" }, ctx);
    expect(JSON.stringify(channels)).not.toContain("SWSCSECRET");
    expect(channels.items[0]).toHaveProperty("domains");
  });

  it("blocks credential-bearing entities and invalid names", async () => {
    await expect(invoke(entitySearch, { entity: "user" }, ctx)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(invoke(entitySearch, { entity: "system-config" }, ctx)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(invoke(entitySearch, { entity: "../oauth" }, ctx)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(requests.filter((r) => r.path.startsWith("/api/search"))).toHaveLength(0);
  });

  it("scrub removes nested secrets", () => {
    expect(
      scrub({
        id: "1",
        accessKey: "x",
        nested: [{ secretAccessKey: "y", ok: true, _uniqueIdentifier: "z" }],
        customFields: { apiToken: "t", note: "n" },
      }),
    ).toEqual({ id: "1", nested: [{ ok: true }], customFields: { note: "n" } });
  });
});

describe("entity_schema", () => {
  it("lists entities without blocked ones and describes fields and associations", async () => {
    const list = await invoke(entitySchema, {}, ctx);
    expect(list).toEqual({ total: 3, entities: ["customer", "product", "product_manufacturer"] });

    const product = await invoke(entitySchema, { entity: "product" }, ctx);
    expect(product).toEqual({
      entity: "product",
      fields: [
        { name: "id", type: "uuid", flags: ["primary_key", "required"] },
        { name: "productNumber", type: "string", flags: ["required"] },
        { name: "name", type: "string", flags: ["translatable"] },
        { name: "stock", type: "int", flags: ["required"] },
      ],
      associations: [
        { name: "manufacturer", relation: "many_to_one", entity: "product_manufacturer" },
        { name: "categories", relation: "many_to_many", entity: "category" },
      ],
    });
    const customer = await invoke(entitySchema, { entity: "customer" }, ctx);
    expect(customer).toMatchObject({
      entity: "customer",
      fields: [
        { name: "id", type: "uuid" },
        { name: "email", type: "string" },
      ],
    });
    expect(JSON.stringify(customer)).not.toContain("password");
    expect(requests.filter((r) => r.path === "/api/_info/entity-schema.json")).toHaveLength(1);

    await expect(invoke(entitySchema, { entity: "nope" }, ctx)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(invoke(entitySchema, { entity: "user" }, ctx)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
