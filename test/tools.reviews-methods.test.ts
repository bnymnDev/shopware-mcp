import { describe, expect, it } from "vitest";
import { orderHistory } from "../src/tools/history.js";
import { paymentMethodsList, shippingMethodsList } from "../src/tools/methods.js";
import { reviewModerate, reviewsSearch } from "../src/tools/reviews.js";
import {
  createContext,
  fixture,
  invoke,
  lastSearch,
  mock,
  searchHandler,
  writeRequests,
} from "./helpers/shopware.js";

const ctx = createContext({ allowWrite: true });
type Body = Record<string, unknown>;
type Rows = { data: Array<Record<string, unknown>> };

describe("reviews_search", () => {
  it("maps reviews with product, reviewer and moderation state and adds the average", async () => {
    const result = await invoke(
      reviewsSearch,
      { filter: [{ type: "equals", field: "status", value: false }] },
      ctx,
    );
    const body = lastSearch("product-review").body as Body;
    expect(body.sort).toEqual([{ field: "createdAt", order: "DESC" }]);
    expect(body.filter).toEqual([{ type: "equals", field: "status", value: false }]);
    expect(body.aggregations).toEqual([{ name: "points", type: "avg", field: "points" }]);
    expect(body.associations).toMatchObject({ product: {}, customer: {}, salesChannel: {} });
    expect(result.total).toBe(5);
    expect(result.averagePoints).toBe(3.4);
    expect(result.items[0]).toMatchObject({
      productNumber: "SW10004",
      points: 1,
      approved: false,
      reviewer: expect.any(String),
      salesChannel: "Storefront",
    });
    expect(result.items.map((item) => item.approved)).toEqual(
      fixture<Rows>("reviews").data.map((review) => review.status),
    );
  });
});

describe("review_moderate", () => {
  const REVIEW = (fixture<Rows>("reviews").data[0] as { id: string }).id;

  it("returns the PATCH on dry run and applies status plus reply otherwise", async () => {
    const dry = await invoke(
      reviewModerate,
      { reviewId: REVIEW, approved: true, comment: "Thank you!" },
      ctx,
    );
    expect(dry).toEqual({
      dryRun: true,
      wouldSend: {
        method: "PATCH",
        url: `https://shop.test/api/product-review/${REVIEW}`,
        body: { status: true, comment: "Thank you!" },
      },
    });
    expect(writeRequests()).toHaveLength(0);

    const applied = await invoke(
      reviewModerate,
      { reviewId: REVIEW, approved: false, dryRun: false },
      ctx,
    );
    expect(writeRequests()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: `/api/product-review/${REVIEW}`,
        body: { status: false },
      }),
    ]);
    expect(applied).toMatchObject({ dryRun: false, result: { id: REVIEW, points: 1 } });
  });
});

describe("payment_methods_list and shipping_methods_list", () => {
  it("lists payment methods with handler and sales channel assignment", async () => {
    mock.use(searchHandler({ "payment-method": "payment-methods" }));
    const result = await invoke(paymentMethodsList, {}, ctx);
    const body = lastSearch("payment-method").body as Body;
    expect(body.sort).toEqual([{ field: "position", order: "ASC" }]);
    expect(result.total).toBe(4);
    expect(result.items[0]).toMatchObject({
      name: "Cash on delivery",
      active: true,
      salesChannels: ["Storefront", "Headless"],
      handler: expect.stringContaining("cash"),
      afterOrderEnabled: expect.any(Boolean),
    });
    expect(result.items.find((item) => item.name === "Direct Debit")?.active).toBe(false);
  });

  it("lists shipping methods with delivery time", async () => {
    const result = await invoke(
      shippingMethodsList,
      { filter: [{ type: "equals", field: "active", value: true }] },
      ctx,
    );
    const body = lastSearch("shipping-method").body as Body;
    expect(body.associations).toMatchObject({ deliveryTime: {}, salesChannels: {} });
    expect(result.items.map((item) => item.name)).toEqual(["Standard", "Express"]);
    expect(result.items[0]).toMatchObject({
      deliveryTime: "1-3 days",
      active: true,
      salesChannels: ["Storefront", "Headless"],
    });
  });
});

describe("order_history", () => {
  it("collects transitions of the order, its deliveries and transactions in order", async () => {
    mock.use(searchHandler({ order: "order-detail" }));
    const result = await invoke(orderHistory, { orderNumber: "10042" }, ctx);
    const order = fixture<Rows>("order-detail").data[0] as Body;
    const expectedIds = [
      order.id,
      ...(order.deliveries as Array<{ id: string }>).map((d) => d.id),
      ...(order.transactions as Array<{ id: string }>).map((t) => t.id),
    ];
    const orderBody = lastSearch("order").body as Body;
    expect(orderBody.filter).toEqual([{ type: "equals", field: "orderNumber", value: "10042" }]);
    const historyBody = lastSearch("state-machine-history").body as Body;
    expect(historyBody.filter).toEqual([
      { type: "equalsAny", field: "referencedId", value: expectedIds },
    ]);
    expect(historyBody.sort).toEqual([{ field: "createdAt", order: "ASC" }]);
    expect(result).toMatchObject({ orderId: order.id, orderNumber: "10042", total: 4 });
    expect(
      result.entries.map((entry) => `${entry.entity}:${entry.action}:${entry.from}>${entry.to}`),
    ).toEqual([
      "order_delivery:ship:open>shipped",
      "order_delivery:reopen:shipped>open",
      "order_transaction:remind:open>reminded",
      "order_transaction:reopen:reminded>open",
    ]);
    expect(result.entries[0]?.by).toEqual({ type: "integration", name: "shopware-mcp e2e" });
  });

  it("requires an identifier", async () => {
    await expect(invoke(orderHistory, {}, ctx)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
