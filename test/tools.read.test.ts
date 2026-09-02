import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { categoriesList } from "../src/tools/categories.js";
import { customersGet, customersSearch } from "../src/tools/customers.js";
import { ordersGet, ordersSearch } from "../src/tools/orders.js";
import { pluginsList } from "../src/tools/plugins.js";
import { productsGet, productsSearch } from "../src/tools/products.js";
import { promotionsList } from "../src/tools/promotions.js";
import { salesChannelsList } from "../src/tools/sales-channels.js";
import { shopInfo } from "../src/tools/shop.js";
import { stockGet } from "../src/tools/stock.js";
import {
  createContext,
  fixture,
  invoke,
  lastSearch,
  mock,
  requests,
  SHOP_URL,
  searchHandler,
} from "./helpers/shopware.js";

const ctx = createContext();
type Body = Record<string, unknown>;

describe("shop_info", () => {
  it("combines version, config, currency and language", async () => {
    const info = await invoke(shopInfo, {}, ctx);
    expect(info).toMatchObject({
      version: "6.6.10.3",
      edition: "Community",
      defaultCurrency: { isoCode: "EUR", symbol: "€", name: "Euro" },
      defaultLanguage: { name: "Deutsch", locale: "de-DE" },
      adminWorkerEnabled: true,
    });
    expect(info.warnings).toBeUndefined();
  });

  it("detects the commercial edition and tolerates a failing config endpoint", async () => {
    mock.use(
      http.get(`${SHOP_URL}/api/_info/config`, () =>
        HttpResponse.json({ bundles: { Framework: {}, SwagCommercial: {} } }),
      ),
    );
    expect((await invoke(shopInfo, {}, ctx)).edition).toBe("Commercial");

    mock.use(
      http.get(`${SHOP_URL}/api/_info/config`, () =>
        HttpResponse.json({ errors: [{ code: "FORBIDDEN", detail: "no" }] }, { status: 403 }),
      ),
    );
    const info = await invoke(shopInfo, {}, ctx);
    expect(info.edition).toBe("unknown");
    expect(info.warnings?.[0]).toContain("config unavailable");
  });
});

describe("sales_channels_list", () => {
  it("maps channels with domains and drops the access key", async () => {
    const page = await invoke(salesChannelsList, { page: 1 }, ctx);
    expect(page.total).toBe(2);
    expect(page.items[0]).toEqual({
      id: "3a4b5c6d7e8f01020304050607080a0b",
      name: "Storefront",
      type: "Storefront",
      typeId: "8a243080f92e4c719546314b577cf82b",
      active: true,
      maintenance: false,
      currency: "EUR",
      language: "Deutsch",
      domains: [
        {
          id: "9b0c1d2e3f405162738495a6b7c8d9e0",
          url: "https://shop.test",
          languageId: "2fbb5fe2e29a4d70aa5854ce7ce3e20b",
          currencyId: "b7d2554b0ce847cd82f3ac9bd1c0dfca",
        },
        {
          id: "0c1d2e3f405162738495a6b7c8d9e0f1",
          url: "https://shop.test/en",
          languageId: "a1c2d3e4f5061728394a5b6c7d8e9f00",
          currencyId: "b7d2554b0ce847cd82f3ac9bd1c0dfca",
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("SWSCSECRET");
  });
});

describe("products_search", () => {
  it("builds criteria with parent-only filter, associations and inheritance header", async () => {
    const page = await invoke(
      productsSearch,
      {
        page: 2,
        limit: 10,
        term: "bag",
        filter: [{ type: "range", field: "stock", value: { lt: 5 } }],
        includeVariants: false,
      },
      ctx,
    );
    const request = lastSearch("product");
    expect(request.headers["sw-inheritance"]).toBe("true");
    expect(request.body).toEqual({
      page: 2,
      limit: 10,
      term: "bag",
      "total-count-mode": 1,
      filter: [
        { type: "equals", field: "parentId", value: null },
        { type: "range", field: "stock", parameters: { lt: 5 } },
      ],
      associations: { manufacturer: {}, categories: {}, cover: { associations: { media: {} } } },
    });
    expect(page).toMatchObject({ total: 42, page: 2, limit: 10 });
  });

  it("maps summaries, resolves currency codes and strips noise", async () => {
    const page = await invoke(productsSearch, { page: 1, includeVariants: true }, ctx);
    const body = lastSearch("product").body as Body;
    expect(body.filter).toBeUndefined();
    expect(body.sort).toEqual([{ field: "productNumber", order: "ASC" }]);
    expect(page.items[0]).toEqual({
      id: "a1b2c3d4e5f60718293a4b5c6d7e8f01",
      productNumber: "SW10001",
      name: "Aerodynamic Bronze Bag",
      parentId: null,
      price: {
        gross: 119,
        net: 100,
        currency: "EUR",
        currencyId: "b7d2554b0ce847cd82f3ac9bd1c0dfca",
        listPriceGross: 149,
      },
      stock: 12,
      availableStock: 10,
      available: true,
      active: true,
      manufacturer: "Acme",
      categories: ["Bags"],
      coverUrl: "https://shop.test/media/bag.jpg",
    });
    expect(page.items[1]?.price?.currency).toBe("EUR");
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("_uniqueIdentifier");
    expect(serialized).not.toContain("versionId");
    expect(serialized).not.toContain("customFields");
  });

  it("adds requested raw fields, including customFields and dot paths", async () => {
    const page = await invoke(
      productsSearch,
      {
        page: 1,
        includeVariants: false,
        fields: ["customFields", "ean", "manufacturer.id", "nope"],
      },
      ctx,
    );
    expect(page.items[0]).toMatchObject({
      customFields: { my_plugin_flag: true },
      ean: "4006381333931",
      "manufacturer.id": "e5f60718293a4b5c6d7e8f0102030405",
      nope: null,
    });
  });
});

describe("products_get", () => {
  it("returns the full product with sorted variants, properties and media", async () => {
    mock.use(searchHandler({ product: "product-detail" }));
    const product = await invoke(
      productsGet,
      { productId: "B2C3D4E5F60718293A4B5C6D7E8F0102" },
      ctx,
    );
    const body = lastSearch("product").body as Body;
    expect(body.filter).toEqual([
      { type: "equals", field: "id", value: "b2c3d4e5f60718293a4b5c6d7e8f0102" },
    ]);
    expect(body.associations).toHaveProperty("children");
    expect(product).toMatchObject({
      productNumber: "SW10002",
      description: "<p>A shirt.</p>",
      tax: { name: "Standard rate", taxRate: 19 },
      properties: [{ group: "Material", value: "Cotton" }],
      variantCount: 2,
    });
    expect(product.media.map((m) => m.position)).toEqual([1, 2]);
    expect(product.media[0]?.alt).toBe("Front");
    expect(product.variants.map((v) => v.productNumber)).toEqual(["SW10002.1", "SW10002.2"]);
    expect(product.variants[0]).toMatchObject({
      options: [{ group: "Size", value: "M" }],
      price: { gross: 27.99, currency: "EUR" },
      stock: 10,
    });
    expect(product.variants[1]?.price).toBeNull();
  });

  it("returns NOT_FOUND for unknown ids", async () => {
    mock.use(searchHandler({ product: () => ({ total: 0, data: [] }) }));
    await expect(
      invoke(productsGet, { productId: "00000000000000000000000000000000" }, ctx),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("orders_search", () => {
  it("maps order summaries with current payment and delivery state", async () => {
    const page = await invoke(ordersSearch, { page: 1 }, ctx);
    const body = lastSearch("order").body as Body;
    expect(body.sort).toEqual([{ field: "orderDateTime", order: "DESC" }]);
    expect(body.associations).toMatchObject({ orderCustomer: {}, transactions: {} });
    expect(page.items[0]).toEqual({
      id: "f60718293a4b5c6d7e8f010203040506",
      orderNumber: "10042",
      orderDate: "2024-06-01T09:15:00.000+00:00",
      amountTotal: 149.99,
      amountNet: 126.04,
      currency: "EUR",
      state: "in_progress",
      paymentState: "paid",
      deliveryState: "open",
      customer: {
        id: "293a4b5c6d7e8f01020304050607080a",
        name: "Max Mustermann",
        email: "max@example.com",
        customerNumber: "10001",
      },
      salesChannelId: "3a4b5c6d7e8f01020304050607080a0b",
      updatedAt: "2024-06-02T08:00:00.000+00:00",
    });
  });
});

describe("orders_get", () => {
  it("looks up by order number and maps line items, addresses, transactions, deliveries", async () => {
    mock.use(searchHandler({ order: "order-detail" }));
    const order = await invoke(ordersGet, { orderNumber: "10042", fields: ["customFields"] }, ctx);
    const body = lastSearch("order").body as Body;
    expect(body.filter).toEqual([{ type: "equals", field: "orderNumber", value: "10042" }]);
    expect(order.lineItems.map((item) => item.label)).toEqual([
      "Aerodynamic Bronze Bag",
      "Summer sale",
    ]);
    expect(order.lineItems[0]).toMatchObject({
      productNumber: "SW10001",
      quantity: 1,
      unitPrice: 119,
    });
    expect(order.billingAddress).toMatchObject({
      city: "Berlin",
      country: "Deutschland",
      countryIso: "DE",
    });
    expect(order.transactions[0]).toMatchObject({
      state: "paid",
      paymentMethod: "PayPal | Storefront",
      amount: 149.99,
    });
    expect(order.deliveries[0]).toMatchObject({
      state: "shipped",
      shippingMethod: "DHL",
      trackingCodes: ["DHL123"],
      shippingAddress: { city: "Hamburg" },
    });
    expect(order).toMatchObject({ customFields: { erp_id: "X-1" }, salesChannel: "Storefront" });
  });

  it("requires an identifier", async () => {
    await expect(invoke(ordersGet, {}, ctx)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("customers", () => {
  it("search maps summaries and never exposes password hashes", async () => {
    const page = await invoke(customersSearch, { page: 1, limit: 5 }, ctx);
    expect(page.items[0]).toMatchObject({
      customerNumber: "10001",
      email: "max@example.com",
      name: "Max Mustermann",
      group: "Standard customer group",
      orderCount: 3,
      lastOrderDate: "2024-06-01T09:15:00.000+00:00",
    });
    expect(JSON.stringify(page)).not.toContain("$2y$");
  });

  it("get resolves addresses with default flags and the default payment method", async () => {
    mock.use(searchHandler({ customer: "customer-detail" }));
    const customer = await invoke(customersGet, { email: "max@example.com" }, ctx);
    expect(lastSearch("customer").body).toMatchObject({
      filter: [{ type: "equals", field: "email", value: "max@example.com" }],
    });
    expect(lastSearch("payment-method").body).toMatchObject({
      filter: [{ type: "equals", field: "id", value: "5c6d7e8f01020304050607080a0b0c0d" }],
    });
    expect(customer).toMatchObject({
      defaultPaymentMethod: "PayPal | Storefront",
      lastPaymentMethod: "Invoice | Storefront",
      birthday: "1990-05-04",
    });
    expect(customer.addresses).toHaveLength(2);
    expect(customer.addresses[0]).toMatchObject({
      isDefaultBilling: true,
      isDefaultShipping: false,
    });
    expect(customer.addresses[1]).toMatchObject({
      isDefaultBilling: false,
      isDefaultShipping: true,
    });
  });

  it("get tolerates a missing defaultPaymentMethodId (Shopware 6.7)", async () => {
    mock.use(
      searchHandler({
        customer: () => {
          const { data } = fixture<{ data: Record<string, unknown>[] }>("customer-detail");
          delete data[0]?.defaultPaymentMethodId;
          return { total: 1, data };
        },
      }),
    );
    const customer = await invoke(customersGet, { customerNumber: "10001" }, ctx);
    expect(customer.defaultPaymentMethod).toBeNull();
    expect(requests.some((r) => r.path === "/api/search/payment-method")).toBe(false);
  });
});

describe("categories_list", () => {
  it("returns a flat list with product counts from one aggregation", async () => {
    mock.use(searchHandler({ product: "category-product-aggregation" }));
    const page = await invoke(categoriesList, { page: 1 }, ctx);
    const aggregation = lastSearch("product").body as Body;
    expect(aggregation).toMatchObject({
      limit: 1,
      filter: [
        {
          type: "equalsAny",
          field: "categories.id",
          value: ["0718293a4b5c6d7e8f01020304050607", "18293a4b5c6d7e8f0102030405060708"],
        },
      ],
      aggregations: [{ name: "byCategory", type: "terms", field: "categories.id" }],
    });
    expect(page.items).toEqual([
      expect.objectContaining({ name: "Catalogue #1", level: 1, parentId: null, productCount: 0 }),
      expect.objectContaining({ name: "Bags", level: 2, productCount: 7 }),
    ]);
    expect("warnings" in page).toBe(false);
  });

  it("degrades to productCount=null with a warning when the aggregation fails", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/product`, () =>
        HttpResponse.json({ errors: [{ code: "X", detail: "no" }] }, { status: 400 }),
      ),
    );
    const page = await invoke(categoriesList, { page: 1 }, ctx);
    expect(page.items[0]?.productCount).toBeNull();
    expect((page as { warnings?: string[] }).warnings?.[0]).toContain("productCount unavailable");
  });
});

describe("promotions_list", () => {
  it("maps codes, validity and discounts", async () => {
    const page = await invoke(promotionsList, { page: 1 }, ctx);
    expect(page.items[0]).toMatchObject({
      name: "Summer sale",
      active: true,
      code: "SUMMER",
      useCodes: true,
      validFrom: "2024-06-01T00:00:00.000+00:00",
      maxRedemptionsGlobal: 1000,
      discounts: [{ scope: "cart", type: "percentage", value: 10 }],
    });
  });
});

describe("plugins_list", () => {
  it("merges plugin search with installed extensions (apps, upgrade info)", async () => {
    const result = await invoke(pluginsList, { activeOnly: false, type: "all" }, ctx);
    expect(result.total).toBe(3);
    expect(result.items.map((item) => item.name)).toEqual([
      "MyTrackingApp",
      "SwagPayPal",
      "SwagPlatformDemoData",
    ]);
    expect(result.items[1]).toMatchObject({
      type: "plugin",
      version: "9.5.0",
      upgradeVersion: "9.6.1",
      active: true,
      installed: true,
    });
    expect(result.items[0]).toMatchObject({ type: "app", upgradeVersion: null, author: "Agency" });
    expect(result.items[2]).toMatchObject({ installed: false, active: false });
    expect((result as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it("filters and still works when the extension endpoint is forbidden", async () => {
    mock.use(
      http.get(`${SHOP_URL}/api/_action/extension/installed`, () =>
        HttpResponse.json(
          { errors: [{ code: "FRAMEWORK__MISSING_PRIVILEGE", detail: "x" }] },
          { status: 403 },
        ),
      ),
    );
    const result = await invoke(pluginsList, { activeOnly: true, type: "plugin" }, ctx);
    expect(result.items.map((item) => item.name)).toEqual(["SwagPayPal"]);
    expect((result as { warnings?: string[] }).warnings?.[0]).toContain(
      "FRAMEWORK__MISSING_PRIVILEGE",
    );
  });
});

describe("stock_get", () => {
  it("looks up by product number and lists variants", async () => {
    mock.use(searchHandler({ product: "product-detail" }));
    const stock = await invoke(stockGet, { productNumber: "SW10002" }, ctx);
    expect(lastSearch("product").body).toMatchObject({
      filter: [{ type: "equals", field: "productNumber", value: "SW10002" }],
    });
    expect(stock).toMatchObject({ productNumber: "SW10002", stock: 15, availableStock: 15 });
    expect(stock.variants).toEqual([
      expect.objectContaining({
        productNumber: "SW10002.1",
        options: ["M"],
        stock: 10,
        availableStock: 9,
      }),
      expect.objectContaining({ productNumber: "SW10002.2", options: ["L"], stock: 5 }),
    ]);
  });

  it("requires an identifier", async () => {
    await expect(invoke(stockGet, {}, ctx)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
