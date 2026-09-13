import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE_ID, STOREFRONT_TYPE_ID } from "../src/client/constants.js";
import type { Raw } from "../src/client/index.js";
import { customerReport } from "../src/tools/customer-report.js";
import { customersSearch, customerUpdate } from "../src/tools/customers.js";
import { orderHistory } from "../src/tools/history.js";
import { paymentMethodsList, shippingMethodsList } from "../src/tools/methods.js";
import { orderDeliveryTransition, ordersSearch } from "../src/tools/orders.js";
import { productCreate, productsSearch } from "../src/tools/products.js";
import { promotionCreate, promotionsList } from "../src/tools/promotions.js";
import { reviewModerate, reviewsSearch } from "../src/tools/reviews.js";
import { salesChannelsList } from "../src/tools/sales-channels.js";
import { stockGet, stockSet } from "../src/tools/stock.js";
import type { ToolContext } from "../src/tools/types.js";
import { E2E_ENABLED, e2eContext } from "./setup.js";

const HEX = /^[0-9a-f]{32}$/;
const suffix = () => randomBytes(3).toString("hex").toUpperCase();

describe.skipIf(!E2E_ENABLED)("extended tools against dockware", () => {
  let ctx: ToolContext;
  let productId: string;
  let storefrontId: string;

  beforeAll(async () => {
    ctx = await e2eContext(true);
    const page = await productsSearch.handler({ page: 1, limit: 1, includeVariants: false }, ctx);
    productId = page.items[0]?.id ?? "";
    expect(productId).toMatch(HEX);
    const channels = await salesChannelsList.handler({ page: 1 }, ctx);
    storefrontId =
      channels.items.find((channel) => channel.typeId === STOREFRONT_TYPE_ID)?.id ??
      channels.items[0]?.id ??
      "";
    expect(storefrontId).toMatch(HEX);
  });

  it("payment_methods_list and shipping_methods_list describe the checkout", async () => {
    const payment = await paymentMethodsList.handler({ page: 1 }, ctx);
    expect(payment.total).toBeGreaterThan(0);
    expect(payment.items[0]).toMatchObject({
      id: expect.stringMatching(HEX),
      name: expect.any(String),
    });
    const shipping = await shippingMethodsList.handler({ page: 1 }, ctx);
    expect(shipping.total).toBeGreaterThan(0);
    expect(shipping.items[0]?.salesChannels).toBeInstanceOf(Array);
  });

  it("customer_report aggregates without failing on any shop", async () => {
    const report = await customerReport.handler(
      { from: "2000-01-01", excludeCancelled: true, topCustomers: 5, compareWithPrevious: true },
      ctx,
    );
    expect(report.newCustomers.total).toBeGreaterThanOrEqual(0);
    expect(report.previousPeriod).toBeDefined();
    if (report.orders.total > 0) {
      expect(report.orderingCustomers.total).toBeGreaterThan(0);
      expect(report.topCustomers[0]).toMatchObject({
        customerId: expect.stringMatching(HEX),
        orders: expect.any(Number),
        revenueShare: expect.any(Number),
      });
    }
  });

  it("order_history lists transitions made through the API", async () => {
    const open = await ordersSearch.handler(
      {
        page: 1,
        limit: 1,
        filter: [
          { type: "equals", field: "stateMachineState.technicalName", value: "open" },
          { type: "equals", field: "deliveries.stateMachineState.technicalName", value: "open" },
        ],
      },
      ctx,
    );
    const orderId = open.items[0]?.id;
    if (!orderId) return;
    const before = await orderHistory.handler({ orderId, limit: 100 }, ctx);
    await orderDeliveryTransition.handler({ orderId, transition: "ship", dryRun: false }, ctx);
    await orderDeliveryTransition.handler({ orderId, transition: "reopen", dryRun: false }, ctx);
    const after = await orderHistory.handler(
      { orderNumber: before.orderNumber ?? "", limit: 100 },
      ctx,
    );
    expect(after.orderId).toBe(orderId);
    expect(after.total).toBe(before.total + 2);
    const newest = after.entries.slice(-2);
    expect(
      newest.map((entry) => `${entry.entity}:${entry.action}:${entry.from}>${entry.to}`),
    ).toEqual(["order_delivery:ship:open>shipped", "order_delivery:reopen:shipped>open"]);
    expect(newest[0]?.by.type).toBe("integration");
  });

  it("reviews_search finds a pending review and review_moderate approves it", async () => {
    const reviewId = randomBytes(16).toString("hex");
    await ctx.client.request("/api/product-review", {
      method: "POST",
      idempotent: false,
      body: {
        id: reviewId,
        productId,
        salesChannelId: storefrontId,
        languageId: DEFAULT_LANGUAGE_ID,
        title: "e2e review",
        content: "Written by the e2e suite; deleted right after.",
        points: 4,
        status: false,
        externalUser: "e2e",
      },
    });
    try {
      const pending = await reviewsSearch.handler(
        { page: 1, filter: [{ type: "equals", field: "id", value: reviewId }] },
        ctx,
      );
      expect(pending.total).toBe(1);
      expect(pending.items[0]).toMatchObject({ approved: false, points: 4, reviewer: "e2e" });
      expect(pending.averagePoints).toBe(4);

      const approved = await reviewModerate.handler(
        { reviewId, approved: true, comment: "Thanks!", dryRun: false },
        ctx,
      );
      expect(approved).toMatchObject({
        dryRun: false,
        result: { id: reviewId, approved: true, comment: "Thanks!" },
      });
    } finally {
      await ctx.client.request(`/api/product-review/${reviewId}`, { method: "DELETE" });
    }
  });

  it("promotion_create creates a coded promotion that promotions_list finds", async () => {
    const code = `E2E${suffix()}`;
    const dry = await promotionCreate.handler(
      {
        name: `e2e ${code}`,
        code,
        discount: { type: "percentage", value: 10 },
        salesChannelIds: [storefrontId],
        active: false,
        dryRun: true,
      },
      ctx,
    );
    expect(dry).toMatchObject({ dryRun: true, wouldSend: { method: "POST" } });

    const created = await promotionCreate.handler(
      {
        name: `e2e ${code}`,
        code,
        discount: { type: "percentage", value: 10 },
        salesChannelIds: [storefrontId],
        active: false,
        dryRun: false,
      },
      ctx,
    );
    if (created.dryRun) throw new Error("expected a write");
    const promotionId = created.result.id ?? "";
    try {
      expect(created.result).toMatchObject({
        code,
        useCodes: true,
        active: false,
        discounts: [{ scope: "cart", type: "percentage", value: 10 }],
      });
      const listed = await promotionsList.handler(
        { page: 1, filter: [{ type: "equals", field: "code", value: code }] },
        ctx,
      );
      expect(listed.total).toBe(1);
    } finally {
      await ctx.client.request(`/api/promotion/${promotionId}`, { method: "DELETE" });
    }
  });

  it("product_create creates a visible product with a derived net price", async () => {
    const productNumber = `E2E-${suffix()}`;
    const created = await productCreate.handler(
      {
        name: `e2e product ${productNumber}`,
        productNumber,
        priceGross: 11.9,
        stock: 3,
        active: true,
        salesChannelIds: [storefrontId],
        dryRun: false,
      },
      ctx,
    );
    if (created.dryRun) throw new Error("expected a write");
    const newId = created.result.id ?? "";
    try {
      expect(created.result).toMatchObject({ productNumber, stock: 3, active: true });
      const rate = created.result.tax?.taxRate ?? 0;
      expect(created.result.price?.gross).toBe(11.9);
      expect(created.result.price?.net).toBeCloseTo(11.9 / (1 + rate / 100), 2);
      const raw = await ctx.client.findById<Raw>("product", newId, {
        associations: { visibilities: {} },
      });
      expect(raw.visibilities).toHaveLength(1);
      const stock = await stockGet.handler({ productNumber }, ctx);
      expect(stock.stock).toBe(3);
    } finally {
      await ctx.client.request(`/api/product/${newId}`, { method: "DELETE" });
    }
  });

  it("customer_update toggles the active flag and restores it", async () => {
    const page = await customersSearch.handler({ page: 1, limit: 1 }, ctx);
    const customer = page.items[0];
    if (!customer?.id) return;
    const active = customer.active ?? true;
    const toggled = await customerUpdate.handler(
      { customerId: customer.id, active: !active, dryRun: false },
      ctx,
    );
    expect(toggled).toMatchObject({ dryRun: false, result: { active: !active } });
    const restored = await customerUpdate.handler(
      { customerId: customer.id, active, dryRun: false },
      ctx,
    );
    expect(restored).toMatchObject({ dryRun: false, result: { active } });
  });

  it("stock_set applies a delta on top of the current stock", async () => {
    const before = (await stockGet.handler({ productId }, ctx)).stock ?? 0;
    const dry = await stockSet.handler({ productId, delta: 3, dryRun: true }, ctx);
    expect(dry).toMatchObject({ dryRun: true, currentStock: before });
    const up = await stockSet.handler({ productId, delta: 3, dryRun: false }, ctx);
    expect(up).toMatchObject({ dryRun: false, result: { stock: before + 3 } });
    const down = await stockSet.handler({ productId, delta: -3, dryRun: false }, ctx);
    expect(down).toMatchObject({ dryRun: false, result: { stock: before } });
  });
});
