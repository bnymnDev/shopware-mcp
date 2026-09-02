import { describe, expect, it } from "vitest";
import { orderStateTransition } from "../src/tools/orders.js";
import { productUpdate } from "../src/tools/products.js";
import { promotionToggle } from "../src/tools/promotions.js";
import { stockSet } from "../src/tools/stock.js";
import {
  createContext,
  invoke,
  mock,
  requests,
  searchHandler,
  writeRequests,
} from "./helpers/shopware.js";

const ctx = createContext({ allowWrite: true });
const PRODUCT = "b2c3d4e5f60718293a4b5c6d7e8f0102";
const ORDER = "f60718293a4b5c6d7e8f010203040506";
const PROMOTION = "4b5c6d7e8f01020304050607080a0b0c";

describe("dry runs", () => {
  it("stock_set returns the request and sends nothing", async () => {
    const result = await invoke(stockSet, { productId: PRODUCT, stock: 3, dryRun: true }, ctx);
    expect(result).toEqual({
      dryRun: true,
      wouldSend: {
        method: "PATCH",
        url: `https://shop.test/api/product/${PRODUCT}`,
        body: { stock: 3 },
      },
    });
    expect(writeRequests()).toHaveLength(0);
    expect(requests.filter((r) => r.path !== "/api/oauth/token")).toHaveLength(0);
  });

  it("order_state_transition returns the request and sends nothing", async () => {
    const result = await invoke(
      orderStateTransition,
      { orderId: ORDER, transition: "complete", dryRun: true },
      ctx,
    );
    expect(result).toEqual({
      dryRun: true,
      wouldSend: {
        method: "POST",
        url: `https://shop.test/api/_action/order/${ORDER}/state/complete`,
        body: {},
      },
    });
    expect(writeRequests()).toHaveLength(0);
  });

  it("promotion_toggle returns the request and sends nothing", async () => {
    const result = await invoke(
      promotionToggle,
      { promotionId: PROMOTION, active: false, dryRun: true },
      ctx,
    );
    expect(result).toMatchObject({
      dryRun: true,
      wouldSend: { method: "PATCH", body: { active: false } },
    });
    expect(writeRequests()).toHaveLength(0);
  });

  it("product_update merges the price with existing currencies (read-only lookup)", async () => {
    mock.use(searchHandler({ product: "products-search" }));
    const result = await invoke(
      productUpdate,
      {
        productId: "a1b2c3d4e5f60718293a4b5c6d7e8f01",
        name: "New name",
        price: { gross: 99, net: 83.19 },
        dryRun: true,
      },
      ctx,
    );
    expect(result).toEqual({
      dryRun: true,
      wouldSend: {
        method: "PATCH",
        url: "https://shop.test/api/product/a1b2c3d4e5f60718293a4b5c6d7e8f01",
        body: {
          name: "New name",
          price: [
            {
              currencyId: "6d7e8f01020304050607080a0b0c0d0e",
              gross: 129,
              net: 108.4,
              linked: true,
            },
            {
              currencyId: "b7d2554b0ce847cd82f3ac9bd1c0dfca",
              gross: 99,
              net: 83.19,
              linked: false,
            },
          ],
        },
      },
    });
    expect(writeRequests()).toHaveLength(0);
  });

  it("product_update rejects empty updates", async () => {
    await expect(
      invoke(productUpdate, { productId: PRODUCT, dryRun: true }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("real writes", () => {
  it("stock_set patches and re-fetches the product", async () => {
    mock.use(searchHandler({ product: "product-detail" }));
    const result = await invoke(stockSet, { productId: PRODUCT, stock: 3, dryRun: false }, ctx);
    const [patch] = writeRequests();
    expect(patch).toMatchObject({
      method: "PATCH",
      path: `/api/product/${PRODUCT}`,
      body: { stock: 3 },
    });
    expect(patch?.headers["content-type"]).toBe("application/json");
    expect(result).toMatchObject({
      dryRun: false,
      result: { productNumber: "SW10002", stock: 15 },
    });
  });

  it("product_update patches basic fields", async () => {
    mock.use(searchHandler({ product: "product-detail" }));
    const result = await invoke(
      productUpdate,
      { productId: PRODUCT, active: false, description: "x", dryRun: false },
      ctx,
    );
    expect(writeRequests()[0]).toMatchObject({ body: { active: false, description: "x" } });
    expect(result).toMatchObject({ dryRun: false, result: { id: PRODUCT } });
  });

  it("order_state_transition posts and returns the re-fetched order", async () => {
    mock.use(searchHandler({ order: "order-detail" }));
    const result = await invoke(
      orderStateTransition,
      { orderId: ORDER, transition: "process", dryRun: false },
      ctx,
    );
    expect(writeRequests()[0]).toMatchObject({
      method: "POST",
      path: `/api/_action/order/${ORDER}/state/process`,
    });
    expect(result).toMatchObject({
      dryRun: false,
      result: { orderNumber: "10042", state: "in_progress" },
    });
  });

  it("promotion_toggle patches and re-fetches", async () => {
    const result = await invoke(
      promotionToggle,
      { promotionId: PROMOTION, active: false, dryRun: false },
      ctx,
    );
    expect(writeRequests()[0]).toMatchObject({
      path: `/api/promotion/${PROMOTION}`,
      body: { active: false },
    });
    expect(result).toMatchObject({ dryRun: false, result: { name: "Summer sale" } });
  });
});
