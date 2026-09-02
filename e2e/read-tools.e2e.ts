import { beforeAll, describe, expect, it } from "vitest";
import { categoriesList } from "../src/tools/categories.js";
import { customersGet, customersSearch } from "../src/tools/customers.js";
import { ordersGet, ordersSearch } from "../src/tools/orders.js";
import { pluginsList } from "../src/tools/plugins.js";
import { productsGet, productsSearch } from "../src/tools/products.js";
import { promotionsList } from "../src/tools/promotions.js";
import { salesChannelsList } from "../src/tools/sales-channels.js";
import { shopInfo } from "../src/tools/shop.js";
import { stockGet } from "../src/tools/stock.js";
import type { ToolContext } from "../src/tools/types.js";
import { E2E_ENABLED, e2eContext } from "./setup.js";

describe.skipIf(!E2E_ENABLED)("read tools against dockware", () => {
  let ctx: ToolContext;
  beforeAll(async () => {
    ctx = await e2eContext();
  });

  it("shop_info reports version and defaults", async () => {
    const info = await shopInfo.handler({}, ctx);
    expect(info.version).toMatch(/^6\.\d+/);
    expect(info.defaultCurrency.isoCode).toBe("EUR");
    expect(info.defaultLanguage.locale).toBeTruthy();
  });

  it("sales_channels_list returns the storefront", async () => {
    const page = await salesChannelsList.handler({ page: 1 }, ctx);
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.some((channel) => channel.type === "Storefront")).toBe(true);
  });

  it("products_search, products_get and stock_get agree", async () => {
    const page = await productsSearch.handler({ page: 1, limit: 5, includeVariants: false }, ctx);
    expect(page.total).toBeGreaterThan(0);
    expect(page.limit).toBe(5);
    const first = page.items[0];
    expect(first?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(first?.parentId).toBeNull();

    const detail = await productsGet.handler({ productId: first?.id ?? "" }, ctx);
    expect(detail.productNumber).toBe(first?.productNumber);
    expect(detail.tax?.taxRate).toBeGreaterThan(0);

    const stock = await stockGet.handler({ productNumber: first?.productNumber ?? "" }, ctx);
    expect(stock.id).toBe(first?.id);
    expect(typeof stock.stock).toBe("number");
  });

  it("products_search honours filters and the 50 cap", async () => {
    const page = await productsSearch.handler(
      {
        page: 1,
        limit: 50,
        includeVariants: true,
        filter: [{ type: "equals", field: "active", value: true }],
        sort: [{ field: "stock", order: "DESC" }],
      },
      ctx,
    );
    expect(page.items.length).toBeLessThanOrEqual(50);
    expect(page.items.every((item) => item.active === true)).toBe(true);
  });

  it("categories_list returns a tree with product counts", async () => {
    const page = await categoriesList.handler({ page: 1, limit: 50 }, ctx);
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.some((category) => category.level === 1)).toBe(true);
    expect(page.items.every((category) => typeof category.productCount === "number")).toBe(true);
  });

  it("orders, customers and promotions do not fail on an empty or seeded shop", async () => {
    const orders = await ordersSearch.handler({ page: 1 }, ctx);
    expect(orders.total).toBeGreaterThanOrEqual(0);
    if (orders.items[0]?.id) {
      const order = await ordersGet.handler({ orderId: orders.items[0].id }, ctx);
      expect(order.orderNumber).toBe(orders.items[0].orderNumber);
      expect(Array.isArray(order.lineItems)).toBe(true);
    }
    const customers = await customersSearch.handler({ page: 1 }, ctx);
    if (customers.items[0]?.id) {
      const customer = await customersGet.handler({ customerId: customers.items[0].id }, ctx);
      expect(customer.email).toBe(customers.items[0].email);
    }
    const promotions = await promotionsList.handler({ page: 1 }, ctx);
    expect(promotions.total).toBeGreaterThanOrEqual(0);
  });

  it("plugins_list lists the framework plugins", async () => {
    const result = await pluginsList.handler({ activeOnly: false, type: "all" }, ctx);
    expect(result.total).toBeGreaterThan(0);
    expect(result.items[0]?.name).toBeTruthy();
  });

  it("returns the compact error shape for unknown ids", async () => {
    await expect(
      productsGet.handler({ productId: "00000000000000000000000000000000" }, ctx),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
