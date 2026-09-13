import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { buildCustomerReport, customerReport } from "../src/tools/customer-report.js";
import { customerUpdate } from "../src/tools/customers.js";
import { productCreate } from "../src/tools/products.js";
import { promotionCreate } from "../src/tools/promotions.js";
import { stockSet } from "../src/tools/stock.js";
import {
  createContext,
  fixture,
  invoke,
  lastSearch,
  mock,
  requests,
  SHOP_URL,
  searchHandler,
  searchRequests,
  wouldSendOf,
  writeRequests,
} from "./helpers/shopware.js";

const ctx = createContext({ allowWrite: true });
type Body = Record<string, unknown>;
type Rows = { data: Array<Record<string, unknown>> };
const HEX = /^[0-9a-f]{32}$/;
const CHANNEL = "01a068fb91ad7260939028219e459a91";
const CUSTOMER = "01a0690928de701bb4a5a788944ea120";

describe("customer_report", () => {
  it("counts new and ordering customers, repeat share and top customers", async () => {
    mock.use(
      searchHandler({ customer: "customer-aggregations", order: "customer-order-aggregations" }),
    );
    const report = await invoke(
      customerReport,
      { from: "2024-06-01", to: "2024-06-30", topCustomers: 3, compareWithPrevious: true },
      ctx,
    );
    const customerBody = searchRequests("customer")[0]?.body as Body;
    expect(customerBody.filter).toEqual([
      {
        type: "range",
        field: "createdAt",
        parameters: { gte: "2024-06-01T00:00:00.000Z", lte: "2024-06-30T23:59:59.999Z" },
      },
    ]);
    const orderBody = searchRequests("order")[0]?.body as Body;
    expect(orderBody.filter).toMatchObject([
      { type: "range", field: "orderDateTime" },
      { type: "not", operator: "and" },
    ]);
    expect((orderBody.aggregations as Array<{ name: string }>).map((a) => a.name)).toEqual([
      "revenue",
      "distinctCustomers",
      "byGuest",
      "byCustomer",
    ]);
    // Names for the top customers are resolved with one lookup by id.
    const lookup = lastSearch("customer").body as Body;
    expect(lookup.filter).toEqual([
      { type: "equalsAny", field: "id", value: report.topCustomers.map((c) => c.customerId) },
    ]);

    expect(report.newCustomers).toMatchObject({ total: 3, registered: 3, guests: 0 });
    expect(report.newCustomers.byGroup.map((group) => group.group)).toContain(
      "Standard customer group",
    );
    expect(report.orders).toEqual({ total: 60, revenueGross: expect.any(Number) });
    expect(report.orderingCustomers).toMatchObject({
      total: 10,
      guestOrders: 0,
      guestOrderShare: 0,
    });
    expect(report.orderingCustomers.repeat).toBeGreaterThan(0);
    expect(report.topCustomers).toHaveLength(3);
    expect(report.topCustomers[0]).toMatchObject({
      customerId: CUSTOMER,
      customerNumber: expect.any(String),
      name: expect.any(String),
      orders: 8,
      revenueGross: 884243.35,
    });
    expect(report.topCustomers[0]?.revenueShare).toBe(37.91);
    // Sorted by revenue, not by order count.
    const revenues = report.topCustomers.map((c) => c.revenueGross);
    expect([...revenues].sort((a, b) => b - a)).toEqual(revenues);
    // The previous period uses the same fixtures, so every change is zero.
    expect(report.previousPeriod).toMatchObject({
      to: "2024-05-31T23:59:59.999Z",
      newCustomers: 3,
      orderingCustomers: 10,
      orders: 60,
    });
    expect(report.change?.orders).toEqual({ absolute: 0, percent: 0 });
  });

  it("defaults to the last 30 days and skips the lookup when nobody ordered", async () => {
    mock.use(
      searchHandler({
        customer: () => ({ total: 0, data: [], aggregations: {} }),
        order: () => ({ total: 0, data: [], aggregations: {} }),
      }),
    );
    const report = await buildCustomerReport(ctx.client, {
      excludeCancelled: false,
      topCustomers: 5,
      compareWithPrevious: false,
    });
    expect(Date.parse(report.period.to) - Date.parse(report.period.from)).toBeCloseTo(
      30 * 86_400_000,
      -4,
    );
    expect(report.orderingCustomers).toMatchObject({ total: 0, repeat: 0, repeatShare: null });
    expect(report.topCustomers).toEqual([]);
    expect(searchRequests("customer")).toHaveLength(1);
    expect(report.previousPeriod).toBeUndefined();
  });
});

describe("promotion_create", () => {
  it("builds a coded cart promotion and only sends it without dryRun", async () => {
    const dry = await invoke(
      promotionCreate,
      {
        name: "Autumn 10",
        code: "AUTUMN10",
        discount: { type: "percentage", value: 10, maxValue: 50 },
        salesChannelIds: [CHANNEL],
        validUntil: "2026-10-31T23:59:59+00:00",
        maxRedemptionsPerCustomer: 1,
      },
      ctx,
    );
    const wouldSend = wouldSendOf(dry);
    expect(wouldSend).toMatchObject({ method: "POST", url: "https://shop.test/api/promotion" });
    const body = wouldSend.body as Body;
    expect(body).toMatchObject({
      name: "Autumn 10",
      active: false,
      useCodes: true,
      code: "AUTUMN10",
      validUntil: "2026-10-31T23:59:59+00:00",
      maxRedemptionsPerCustomer: 1,
      discounts: [
        {
          scope: "cart",
          type: "percentage",
          value: 10,
          maxValue: 50,
          considerAdvancedRules: false,
        },
      ],
      salesChannels: [{ salesChannelId: CHANNEL, priority: 1 }],
    });
    expect(body.id).toMatch(HEX);
    expect(body).not.toHaveProperty("validFrom");
    expect(writeRequests()).toHaveLength(0);

    const applied = await invoke(
      promotionCreate,
      {
        name: "Free shipping week",
        discount: { type: "absolute", value: 4.9 },
        salesChannelIds: [CHANNEL],
        active: true,
        dryRun: false,
      },
      ctx,
    );
    const sent = writeRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", path: "/api/promotion" });
    const sentBody = sent[0]?.body as Body;
    expect(sentBody).toMatchObject({ useCodes: false, active: true });
    expect(sentBody).not.toHaveProperty("code");
    // The new promotion is read back by the id chosen up front.
    expect(lastSearch("promotion").body).toMatchObject({
      filter: [{ type: "equals", field: "id", value: sentBody.id }],
    });
    expect(applied).toMatchObject({ dryRun: false, result: { id: expect.any(String) } });
  });

  it("rejects a percentage above 100 and an inverted validity window", async () => {
    await expect(
      invoke(
        promotionCreate,
        { name: "x", discount: { type: "percentage", value: 250 }, salesChannelIds: [CHANNEL] },
        ctx,
      ),
    ).rejects.toThrow(/cannot exceed 100/);
    await expect(
      invoke(
        promotionCreate,
        {
          name: "x",
          discount: { type: "absolute", value: 5 },
          salesChannelIds: [CHANNEL],
          validFrom: "2026-11-01",
          validUntil: "2026-10-01",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects codes with spaces or symbols", async () => {
    await expect(
      invoke(
        promotionCreate,
        {
          name: "x",
          code: "SUMMER 26!",
          discount: { type: "percentage", value: 5 },
          salesChannelIds: [CHANNEL],
        },
        ctx,
      ),
    ).rejects.toThrow(/Letters, digits/);
  });
});

describe("product_create", () => {
  it("derives the net price from the tax rate and explains the tax choice", async () => {
    mock.use(searchHandler({ tax: () => ({ total: 1, data: [fixture<Rows>("taxes").data[0]] }) }));
    const dry = await invoke(
      productCreate,
      {
        name: "Bench",
        productNumber: "SW10900",
        priceGross: 119,
        taxRate: 19,
        salesChannelIds: [CHANNEL],
      },
      ctx,
    );
    expect(lastSearch("tax").body).toMatchObject({
      filter: [{ type: "equals", field: "taxRate", value: 19 }],
    });
    expect(dry).toMatchObject({
      dryRun: true,
      tax: { rate: 19, name: "Standard rate", id: expect.stringMatching(HEX) },
    });
    const body = wouldSendOf(dry).body as Body;
    expect(body).toMatchObject({
      name: "Bench",
      productNumber: "SW10900",
      stock: 0,
      active: true,
      price: [
        { currencyId: "b7d2554b0ce847cd82f3ac9bd1c0dfca", gross: 119, net: 100, linked: true },
      ],
      visibilities: [{ salesChannelId: CHANNEL, visibility: 30 }],
    });
    expect(body.taxId).toMatch(HEX);
    expect(writeRequests()).toHaveLength(0);
  });

  it("falls back to the highest rate when the shop has no default tax and applies the POST", async () => {
    const applied = await invoke(
      productCreate,
      { name: "Crate", productNumber: "SW10901", priceGross: 10, stock: 5, dryRun: false },
      ctx,
    );
    // No taxId/taxRate: the default-tax setting is consulted, then the highest rate wins.
    expect(requests.some((r) => r.path === "/api/_action/system-config?domain=core.tax")).toBe(
      true,
    );
    expect(lastSearch("tax").body).toMatchObject({ sort: [{ field: "taxRate", order: "DESC" }] });
    const sent = writeRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", path: "/api/product" });
    const sentBody = sent[0]?.body as Body;
    expect(sentBody).toMatchObject({ stock: 5, price: [{ gross: 10, net: 8.4 }] });
    expect(sentBody).not.toHaveProperty("visibilities");
    expect(applied).toMatchObject({ dryRun: false, result: { productNumber: expect.any(String) } });
  });

  it("uses the configured default tax and accepts an explicit taxId", async () => {
    const taxes = fixture<Rows>("taxes").data as Array<{ id: string; taxRate: number }>;
    const reduced = taxes.find((tax) => tax.taxRate === 7);
    if (!reduced) throw new Error("fixture has no 7 % tax");
    mock.use(
      http.get(`${SHOP_URL}/api/_action/system-config`, () =>
        HttpResponse.json({ "core.tax.defaultTaxRate": reduced.id }),
      ),
      http.post(`${SHOP_URL}/api/search/tax`, async ({ request }) => {
        const body = (await request.json()) as { filter?: Array<{ field: string; value: string }> };
        const wanted = body.filter?.find((f) => f.field === "id")?.value;
        return HttpResponse.json({ total: 1, data: taxes.filter((tax) => tax.id === wanted) });
      }),
    );
    const byDefault = await invoke(
      productCreate,
      { name: "Mug", productNumber: "SW10902", priceGross: 10.7 },
      ctx,
    );
    expect(byDefault).toMatchObject({ dryRun: true, tax: { id: reduced.id, rate: 7 } });
    expect(wouldSendOf(byDefault).body).toMatchObject({ taxId: reduced.id, price: [{ net: 10 }] });

    const standard = taxes.find((tax) => tax.taxRate === 19);
    if (!standard) throw new Error("fixture has no 19 % tax");
    const byId = await invoke(
      productCreate,
      { name: "Mug", productNumber: "SW10902", priceGross: 11.9, taxId: standard.id },
      ctx,
    );
    expect(byId).toMatchObject({ dryRun: true, tax: { id: standard.id, rate: 19 } });
    expect(wouldSendOf(byId).body).toMatchObject({ price: [{ gross: 11.9, net: 10 }] });
  });

  it("refuses an ambiguous tax rate", async () => {
    // The default fixture answers every tax search with all three rates.
    await expect(
      invoke(productCreate, { name: "x", productNumber: "y", priceGross: 1, taxRate: 19 }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", detail: expect.stringContaining("Several") });
  });

  it("refuses both taxId and taxRate", async () => {
    await expect(
      invoke(
        productCreate,
        { name: "x", productNumber: "y", priceGross: 1, taxId: CHANNEL, taxRate: 7 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("customer_update", () => {
  it("patches active and group and reads the customer back", async () => {
    mock.use(searchHandler({ customer: "customer-detail" }));
    const dry = await invoke(customerUpdate, { customerId: CUSTOMER, active: false }, ctx);
    expect(dry).toEqual({
      dryRun: true,
      wouldSend: {
        method: "PATCH",
        url: `https://shop.test/api/customer/${CUSTOMER}`,
        body: { active: false },
      },
    });
    const applied = await invoke(
      customerUpdate,
      { customerId: CUSTOMER, groupId: CHANNEL, dryRun: false },
      ctx,
    );
    expect(writeRequests()).toEqual([
      expect.objectContaining({ method: "PATCH", body: { groupId: CHANNEL } }),
    ]);
    expect(applied).toMatchObject({ dryRun: false, result: { email: expect.any(String) } });
  });

  it("needs at least one field", async () => {
    await expect(invoke(customerUpdate, { customerId: CUSTOMER }, ctx)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("stock_set delta", () => {
  const product = fixture<Rows>("products-search").data[0] as { id: string; stock: number };

  it("reads the current stock and applies the change", async () => {
    const dry = await invoke(stockSet, { productId: product.id, delta: -2 }, ctx);
    expect(dry).toMatchObject({
      dryRun: true,
      currentStock: product.stock,
      wouldSend: { body: { stock: product.stock - 2 } },
    });
    expect(writeRequests()).toHaveLength(0);
  });

  it("writes the computed stock and reads the product back", async () => {
    const applied = await invoke(stockSet, { productId: product.id, delta: 5, dryRun: false }, ctx);
    expect(writeRequests()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: `/api/product/${product.id}`,
        body: { stock: product.stock + 5 },
      }),
    ]);
    expect(applied).toMatchObject({ dryRun: false, result: { id: product.id } });
  });

  it("refuses to go below zero and needs exactly one of stock or delta", async () => {
    await expect(
      invoke(stockSet, { productId: product.id, delta: -(product.stock + 1) }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(invoke(stockSet, { productId: product.id }, ctx)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      invoke(stockSet, { productId: product.id, stock: 1, delta: 1 }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
