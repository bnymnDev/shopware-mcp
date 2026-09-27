import { type HttpHandler, HttpResponse, http, type JsonBodyType } from "msw";
import { describe, expect, it } from "vitest";
import {
  cartErrors,
  checkoutSimulate,
  storefrontSearch,
  tierFor,
} from "../src/tools/storefront.js";
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
} from "./helpers/shopware.js";

const ctx = createContext();
const HEADLESS = "98432def39fc4624b33213a56b8c944d";
const STOREFRONT = "01a068fb91ad7260939028219e459a91";
const CH = "01a068fb69b47090835fd7e37e873421";
const INVOICE = "01a068fb69fe71e6948ffd608d7cb535";
const CUSTOMER = "01a0690928f1703ebf786c33c326cba4";
const LANGUAGE = "2fbb5fe2e29a4d70aa5854ce7ce3e20b";
const SW10005 = "01a069093244728b952dad42d3e77e00";
type Body = Record<string, unknown>;

interface StoreCall {
  method: string;
  path: string;
  token: string | null;
  language: string | null;
  body: unknown;
}

/** The Store API behind Shopware's admin proxy, answering with real responses from a shop. */
function storeApi(overrides: Partial<Record<string, () => Response>> = {}) {
  const calls: StoreCall[] = [];
  const record = async (request: Request, path: string) => {
    const text = await request.clone().text();
    calls.push({
      method: request.method,
      path,
      token: request.headers.get("sw-context-token"),
      language: request.headers.get("sw-language-id"),
      body: text ? JSON.parse(text) : undefined,
    });
  };
  const route = (
    method: "get" | "post" | "patch" | "delete",
    path: string,
    answer: () => Response,
  ): HttpHandler =>
    http[method](`${SHOP_URL}/api/_proxy/store-api/:channel/${path}`, async ({ request }) => {
      await record(request, path);
      return (overrides[path] ?? answer)();
    });
  const json = (name: string) => () => HttpResponse.json(fixture<JsonBodyType>(name));
  const handlers = [
    route("patch", "context", () => HttpResponse.json({ redirectUrl: null })),
    route("post", "checkout/cart/line-item", json("storefront-cart-ch")),
    route("post", "payment-method", json("storefront-payment-methods")),
    route("post", "shipping-method", json("storefront-shipping-methods")),
    route("post", "product", json("storefront-listing")),
    route("post", "search", json("storefront-search")),
    route("delete", "checkout/cart", () => new HttpResponse(null, { status: 204 })),
    http.patch(`${SHOP_URL}/api/_proxy/switch-customer`, async ({ request }) => {
      await record(request, "switch-customer");
      return HttpResponse.json({ "sw-context-token": "x" });
    }),
  ];
  return { calls, handlers };
}

/** Admin searches for the storefront tools; country answers by what was asked. */
function adminSearches(extra: Record<string, string | (() => unknown)> = {}): HttpHandler[] {
  return [
    http.post(`${SHOP_URL}/api/search/country`, async ({ request }) => {
      const body = await request.clone().text();
      return HttpResponse.json(
        fixture<JsonBodyType>(
          body.includes("salesChannels.id") ? "storefront-countries" : "storefront-country-ch",
        ),
      );
    }),
    searchHandler({
      "sales-channel": "storefront-channels",
      product: "storefront-products",
      promotion: "storefront-promotion",
      customer: "storefront-customer",
      "product-search-keyword": "storefront-keywords",
      ...extra,
    }),
  ];
}

describe("checkout_simulate", () => {
  it("explains a blocked country and an expired code, and prices the tier the page shows", async () => {
    const store = storeApi({
      product: () => HttpResponse.json(fixture("storefront-listing-ch")),
    });
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      checkoutSimulate,
      {
        salesChannel: "headless",
        items: [{ productNumber: "SW10005", quantity: 2 }],
        promotionCodes: ["SUMMER26"],
        country: "ch",
      },
      ctx,
    );

    expect(store.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PATCH context",
      "POST checkout/cart/line-item",
      "POST payment-method",
      "POST shipping-method",
      "POST product",
      "DELETE checkout/cart",
    ]);
    const tokens = new Set(store.calls.map((call) => call.token));
    expect(tokens.size).toBe(1);
    expect([...tokens][0]).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(store.calls.map((call) => call.language))).toEqual(new Set([LANGUAGE]));
    expect(store.calls[0]?.body).toEqual({ countryId: CH });
    expect(store.calls[1]?.body).toEqual({
      items: [
        {
          id: "01a069093244728b952dad42d3e77e00",
          type: "product",
          referencedId: "01a069093244728b952dad42d3e77e00",
          quantity: 2,
        },
        { type: "promotion", referencedId: "SUMMER26" },
      ],
    });
    expect(requests.some((r) => r.path.includes("_proxy-order"))).toBe(false);
    expect(lastSearch("promotion").body).toMatchObject({
      filter: [{ type: "equals", field: "code", value: "SUMMER26" }],
    });

    expect(result).toMatchObject({
      salesChannel: { id: HEADLESS, name: "Headless" },
      as: { guest: true, shipsTo: "CH" },
      canOrder: false,
      currency: "EUR",
      taxStatus: "tax-free",
      items: [
        {
          productNumber: "SW10005",
          requested: 2,
          quantity: 2,
          unitPrice: 12.01,
          totalPrice: 24.02,
          listingPrice: 12.01,
          priceTier: "1 to 10 units",
        },
      ],
      totals: { total: 24.02, shipping: 0 },
      cartDeleted: true,
    });
    expect(result.problems).toEqual([
      {
        key: "shipping-address-blocked",
        level: "error",
        blocksOrder: true,
        message: "Shipping to the selected shipping address is currently not possible.",
        explanation: "Switzerland is not among the countries of Headless (DE, GB)",
      },
      {
        key: "promotion-not-found",
        level: "error",
        blocksOrder: false,
        message: 'Promo code "SUMMER26" could not be found.',
        explanation: '"SUMMER26" belongs to "Summer Sale 2026", but it ended on 2026-08-31',
      },
    ]);
    expect(result.paymentMethods).toEqual({
      selected: "Cash on delivery",
      available: ["Cash on delivery", "Paid in advance", "Invoice"],
      hidden: [{ name: "Direct Debit", reason: "inactive" }],
    });
    expect(result.shippingMethods).toMatchObject({ selected: "Standard", hidden: [] });
  });

  it("logs in as the customer, selects a payment method and ships to their address", async () => {
    const store = storeApi({
      "checkout/cart/line-item": () => HttpResponse.json(fixture("storefront-cart-customer")),
    });
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      checkoutSimulate,
      {
        salesChannel: HEADLESS,
        items: [
          { productNumber: "SW10005", quantity: 1 },
          { productNumber: "SW10006", quantity: 3 },
        ],
        customerNumber: "10009",
        paymentMethod: "invoice",
      },
      ctx,
    );
    expect(store.calls[0]).toMatchObject({
      method: "PATCH",
      path: "switch-customer",
      body: { salesChannelId: HEADLESS, customerId: CUSTOMER },
    });
    expect(store.calls[1]).toMatchObject({ path: "context", body: { paymentMethodId: INVOICE } });
    expect(new Set(store.calls.map((call) => call.token)).size).toBe(1);
    expect(lastSearch("customer").body).toMatchObject({
      filter: [{ type: "equals", field: "customerNumber", value: "10009" }],
    });
    expect(result).toMatchObject({
      as: {
        customerNumber: "10009",
        name: "Friedrich Homenick",
        group: "Standard customer group",
        active: true,
        loggedIn: true,
        shipsTo: "US",
      },
      canOrder: false,
      items: [
        { productNumber: "SW10005", unitPrice: 1429.7, listingPrice: 1429.7 },
        { productNumber: "SW10006", quantity: 3, unitPrice: 1855.97, listingPrice: 1855.97 },
      ],
      totals: { total: 6997.61 },
    });
    expect(result.problems[0]).toMatchObject({
      key: "shipping-address-blocked",
      explanation: "United States of America is not among the countries of Headless (DE, GB)",
    });
    expect(result.paymentMethods?.selected).toBe("Invoice");
  });

  it("stops at maintenance mode without touching the Store API", async () => {
    const store = storeApi();
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(checkoutSimulate, { items: [{ productNumber: "SW10005" }] }, ctx);
    expect(result).toMatchObject({
      salesChannel: { id: STOREFRONT, name: "Storefront" },
      canOrder: false,
      problems: [{ key: "maintenance", blocksOrder: true }],
      cartDeleted: false,
    });
    expect(store.calls).toEqual([]);
    expect(searchRequests("product")).toEqual([]);
  });

  it("deletes the cart even when a later Store API call fails", async () => {
    const store = storeApi({
      "payment-method": () =>
        HttpResponse.json(
          { errors: [{ status: "500", code: "X", detail: "boom" }] },
          { status: 500 },
        ),
    });
    mock.use(...adminSearches(), ...store.handlers);
    await expect(
      invoke(
        checkoutSimulate,
        { salesChannel: "Headless", items: [{ productNumber: "SW10005" }] },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 500 });
    // Every parallel call has answered before the cart goes, so none can bring it back.
    expect(store.calls.map((call) => call.path).slice(-4)).toEqual([
      "payment-method",
      "shipping-method",
      "product",
      "checkout/cart",
    ]);
    expect(store.calls.at(-1)).toMatchObject({ method: "DELETE", path: "checkout/cart" });
  });

  it("reports a payment method that the channel does not offer instead of selecting it", async () => {
    const store = storeApi();
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      checkoutSimulate,
      {
        salesChannel: "Headless",
        items: [{ productNumber: "SW10005" }],
        paymentMethod: "PayPal",
      },
      ctx,
    );
    expect(store.calls.some((call) => call.path === "context")).toBe(false);
    expect(result.problems[0]).toMatchObject({
      key: "payment-method-not-assigned",
      blocksOrder: false,
      explanation: expect.stringContaining("Invoice"),
    });
  });

  it("rejects contradictory or incomplete input and unknown channels", async () => {
    mock.use(...adminSearches());
    await expect(invoke(checkoutSimulate, { items: [{ quantity: 1 }] }, ctx)).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    await expect(
      invoke(
        checkoutSimulate,
        { items: [{ productNumber: "SW1" }], country: "DE", customerNumber: "10009" },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("guest") });
    await expect(
      invoke(checkoutSimulate, { salesChannel: "Nope", items: [{ productNumber: "SW1" }] }, ctx),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Headless") });
  });

  it("flags a price the product page does not show, naming the tier", async () => {
    const listing = fixture<{ elements: Body[] }>("storefront-listing-ch");
    const first = listing.elements[0];
    if (!first) throw new Error("fixture too small");
    first.calculatedPrices = [
      { unitPrice: 15, quantity: 10 },
      { unitPrice: 9, quantity: 11 },
    ];
    const store = storeApi({ product: () => HttpResponse.json(listing as JsonBodyType) });
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      checkoutSimulate,
      { salesChannel: "Headless", items: [{ productNumber: "sw10005", quantity: 2 }] },
      ctx,
    );
    expect(result.items[0]).toMatchObject({ listingPrice: 15, unitPrice: 12.01 });
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        key: "price-differs-from-listing",
        blocksOrder: false,
        message: "SW10005 shows 15 per unit (tier 1 to 10 units) but costs 12.01 in the cart.",
      }),
    );
  });

  it("does not log in an inactive customer and says the cart is a guest's", async () => {
    const store = storeApi();
    mock.use(
      ...adminSearches({
        customer: () => {
          const found = fixture<{ data: Body[] }>("storefront-customer");
          if (found.data[0]) found.data[0].active = false;
          return found;
        },
      }),
      ...store.handlers,
    );
    const result = await invoke(
      checkoutSimulate,
      { salesChannel: "Headless", items: [{ productNumber: "SW10005" }], customerNumber: "10009" },
      ctx,
    );
    expect(store.calls.some((call) => call.path === "switch-customer")).toBe(false);
    expect(result.as).toMatchObject({ customerNumber: "10009", loggedIn: false, shipsTo: null });
    expect(result.canOrder).toBe(false);
    expect(result.problems[0]).toMatchObject({
      key: "customer-inactive",
      blocksOrder: true,
      explanation: expect.stringContaining("priced for a guest"),
    });
  });

  it("names the channel a customer is bound to", async () => {
    const store = storeApi();
    mock.use(
      ...adminSearches({
        customer: () => {
          const found = fixture<{ data: Body[] }>("storefront-customer");
          if (found.data[0]) found.data[0].boundSalesChannelId = STOREFRONT;
          return found;
        },
      }),
      ...store.handlers,
    );
    const result = await invoke(
      checkoutSimulate,
      { salesChannel: "Headless", items: [{ productNumber: "SW10005" }], customerNumber: "10009" },
      ctx,
    );
    expect(result.problems[0]).toMatchObject({
      key: "customer-bound-to-other-channel",
      blocksOrder: true,
      message: "Customer 10009 is bound to Storefront and cannot log in to Headless.",
    });
  });

  it("explains a parent product that Shopware drops from the cart without a word", async () => {
    const products = fixture<{ data: Body[] }>("storefront-products");
    const parent = products.data.find((entry) => entry.productNumber === "SW10005");
    if (!parent) throw new Error("fixture too small");
    parent.childCount = 3;
    const cart = fixture<Body>("storefront-cart-ch");
    cart.lineItems = [];
    cart.errors = [];
    const store = storeApi({
      "checkout/cart/line-item": () => HttpResponse.json(cart as JsonBodyType),
    });
    mock.use(
      ...adminSearches({
        product: (() => {
          let call = 0;
          return () =>
            call++ === 0
              ? products
              : {
                  total: 2,
                  data: [{ productNumber: "SW10005.1" }, { productNumber: "SW10005.2" }],
                };
        })(),
      }),
      ...store.handlers,
    );
    const result = await invoke(
      checkoutSimulate,
      { salesChannel: "Headless", items: [{ productNumber: "SW10005" }] },
      ctx,
    );
    expect(result.canOrder).toBe(false);
    expect(result.items[0]).toMatchObject({ requested: 1, quantity: 0 });
    expect(result.problems).toContainEqual({
      key: "product-has-variants",
      level: "error",
      blocksOrder: true,
      message: "SW10005 has 3 variants and cannot be bought itself.",
      explanation:
        "Shopware removes a parent product from the cart without a message; put a variant in the cart instead, e.g. SW10005.1, SW10005.2",
    });
    expect(lastSearch("product").body).toMatchObject({
      filter: [{ type: "equals", field: "parentId", value: SW10005 }],
    });
  });

  it("matches product errors by id, not by the name in the channel's language", async () => {
    const cart = fixture<Body>("storefront-cart-ch");
    cart.errors = {
      [`product-stock-reached${SW10005}`]: {
        key: `product-stock-reached${SW10005}`,
        messageKey: "product-stock-reached",
        parameters: { name: "Fantastische Schildkröte", quantity: 5 },
        level: 20,
        block: true,
        translatedMessage: "Nur 5 verfügbar",
      },
    };
    const store = storeApi({
      "checkout/cart/line-item": () => HttpResponse.json(cart as JsonBodyType),
    });
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      checkoutSimulate,
      { salesChannel: "Headless", items: [{ productNumber: "SW10005", quantity: 30 }] },
      ctx,
    );
    expect(result.problems[0]).toMatchObject({
      key: "product-stock-reached",
      explanation: "Only 19 of SW10005 are available; the cart lowered the quantity to 5",
    });
  });

  it("names every rule a promotion code breaks, down to the per-customer limit", async () => {
    const store = storeApi({
      "checkout/cart/line-item": () => HttpResponse.json(fixture("storefront-cart-ch")),
    });
    mock.use(
      ...adminSearches({
        promotion: () => {
          const found = fixture<{ data: Body[] }>("storefront-promotion");
          const promotion = found.data[0];
          if (promotion) {
            Object.assign(promotion, {
              validUntil: null,
              salesChannels: [],
              useIndividualCodes: true,
              maxRedemptionsPerCustomer: 5,
              discounts: [],
            });
          }
          return found;
        },
      }),
      ...store.handlers,
    );
    const result = await invoke(
      checkoutSimulate,
      {
        salesChannel: "Headless",
        items: [{ productNumber: "SW10005" }],
        promotionCodes: ["SUMMER26"],
        customerNumber: "10009",
      },
      ctx,
    );
    const problem = result.problems.find((entry) => entry.key === "promotion-not-found");
    expect(problem?.explanation).toBe(
      '"SUMMER26" belongs to "Summer Sale 2026", but it is not assigned to any sales channel, ' +
        "and it now uses individual codes, so its fixed code no longer works, " +
        "and this customer has used it 5 times, the limit per customer, " +
        "and it has no discount configured",
    );
    expect(lastSearch("promotion").body).toMatchObject({
      associations: { salesChannels: {}, discounts: {} },
    });
  });

  it("explains a refused individual code whose promotion went back to one fixed code", async () => {
    const store = storeApi();
    mock.use(
      ...adminSearches({
        promotion: () => ({ total: 0, data: [] }),
        "promotion-individual-code": () => {
          const promotion = fixture<{ data: Body[] }>("storefront-promotion").data[0];
          return {
            total: 1,
            data: [{ payload: null, promotion: { ...promotion, validUntil: null } }],
          };
        },
      }),
      ...store.handlers,
    );
    const result = await invoke(
      checkoutSimulate,
      {
        salesChannel: "Headless",
        items: [{ productNumber: "SW10005" }],
        promotionCodes: ["SUMMER26"],
      },
      ctx,
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        key: "promotion-not-found",
        explanation:
          '"SUMMER26" belongs to "Summer Sale 2026", but it now uses one fixed code, so its individual codes no longer work',
      }),
    );
  });

  it("reads tiers the way the product page shows them", () => {
    const tiers = [
      { quantity: 10, unitPrice: 5 },
      { quantity: 20, unitPrice: 4 },
      { quantity: 21, unitPrice: 3 },
    ];
    expect(tierFor(tiers, 3)).toEqual({ unitPrice: 5, label: "1 to 10 units" });
    expect(tierFor(tiers, 11)).toEqual({ unitPrice: 4, label: "11 to 20 units" });
    expect(tierFor(tiers, 21)).toEqual({ unitPrice: 3, label: "from 21 units" });
    expect(tierFor(tiers, 500)).toEqual({ unitPrice: 3, label: "from 21 units" });
    expect(tierFor([{ quantity: 1, unitPrice: 7 }], 4)).toEqual({
      unitPrice: 7,
      label: "from 1 units",
    });
    expect(tierFor([], 4)).toBeNull();
  });

  it("reads cart errors from Shopware's keyed object and from an empty list", () => {
    expect(cartErrors({ errors: [] })).toEqual([]);
    expect(cartErrors({ errors: { a: { messageKey: "x" }, b: "junk" } })).toEqual([
      { messageKey: "x" },
    ]);
  });
});

describe("storefront_search", () => {
  it("returns what a customer finds, in order, with the price they see", async () => {
    const store = storeApi();
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      storefrontSearch,
      { term: "steel", salesChannel: "Headless", limit: 3 },
      ctx,
    );
    expect(store.calls).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "search",
        body: expect.objectContaining({ search: "steel", limit: 3 }),
      }),
    ]);
    expect(result).toMatchObject({ term: "steel", total: 7 });
    expect(result.items).toEqual([
      {
        position: 1,
        productNumber: "SW10003.1",
        name: "Ergonomic Steel Dream Fire",
        price: 918.39,
        available: true,
        stock: 29,
      },
      expect.objectContaining({ position: 2, productNumber: "SW10005", price: 791.77 }),
      expect.objectContaining({ position: 3, productNumber: "SW10006" }),
    ]);
    expect(result.items[0]).not.toHaveProperty("fromPrice");
  });

  it("names the position of a product that is found", async () => {
    const store = storeApi();
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      storefrontSearch,
      { term: "steel", salesChannel: "Headless", explain: "SW10005" },
      ctx,
    );
    expect(store.calls[0]?.body).toMatchObject({ limit: 100 });
    expect(result.explain).toEqual({
      productNumber: "SW10005",
      found: true,
      position: 2,
      page: 1,
      reasons: [],
    });
  });

  it("finds a variant through the sibling that search shows for its product", async () => {
    const search = fixture<{ elements: Body[] }>("storefront-search");
    const first = search.elements[0];
    if (!first) throw new Error("fixture too small");
    first.parentId = "01a06909323f73a9ba0ea4a0b0a57a3f";
    const store = storeApi({ search: () => HttpResponse.json(search as JsonBodyType) });
    mock.use(
      ...adminSearches({
        product: () => {
          const products = fixture<{ data: Body[] }>("storefront-products");
          const product = products.data[0];
          if (product) {
            Object.assign(product, {
              id: "01a06909324473a9ba0ea4a0b0a57a40",
              parentId: "01a06909323f73a9ba0ea4a0b0a57a3f",
              productNumber: "SW10003.2",
            });
          }
          return { total: 1, data: product ? [product] : [] };
        },
      }),
      ...store.handlers,
    );
    const result = await invoke(
      storefrontSearch,
      { term: "steel", salesChannel: "Headless", explain: "sw10003.2" },
      ctx,
    );
    expect(result.explain).toEqual({
      productNumber: "SW10003.2",
      found: true,
      position: 1,
      page: 1,
      shownAs: "SW10003.1",
      reasons: ["search shows one variant per product; SW10003.1 stands for its variants here"],
    });
  });

  it("explains a product that is not visible in the channel", async () => {
    const store = storeApi();
    mock.use(
      ...adminSearches({
        product: "storefront-product-hidden",
        "product-search-keyword": () => ({
          total: 3,
          data: [{ keyword: "fantastic" }, { keyword: "steel" }, { keyword: "shirt" }],
        }),
      }),
      ...store.handlers,
    );
    const result = await invoke(
      storefrontSearch,
      { term: "steel shirt", salesChannel: "Headless", explain: "SW10002" },
      ctx,
    );
    expect(result.explain).toMatchObject({
      productNumber: "SW10002",
      found: false,
      reasons: ["it is not visible in Headless"],
    });
  });

  it("explains a term that none of the product's search keywords contain", async () => {
    const store = storeApi({ search: () => HttpResponse.json({ elements: [], total: 0 }) });
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      storefrontSearch,
      { term: "hoodie", salesChannel: "Headless", explain: "SW10005" },
      ctx,
    );
    expect(lastSearch("product-search-keyword").body).toMatchObject({
      filter: [
        { type: "equals", field: "productId", value: "01a069093244728b952dad42d3e77e00" },
        { type: "equals", field: "languageId", value: expect.any(String) },
      ],
    });
    expect(result.explain?.reasons).toEqual([
      expect.stringMatching(/^none of its search keywords contain "hoodie"; they include awesome/),
    ]);
  });

  it("says the index is missing when a product has no keywords at all", async () => {
    const store = storeApi({ search: () => HttpResponse.json({ elements: [], total: 0 }) });
    mock.use(
      ...adminSearches({ "product-search-keyword": () => ({ total: 0, data: [] }) }),
      ...store.handlers,
    );
    const result = await invoke(
      storefrontSearch,
      { term: "turtle", salesChannel: "Headless", explain: "SW10005" },
      ctx,
    );
    expect(result.explain?.reasons).toEqual([expect.stringContaining("search index")]);
  });

  it("answers for a channel in maintenance without searching", async () => {
    const store = storeApi();
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(storefrontSearch, { term: "steel" }, ctx);
    expect(result).toMatchObject({
      total: 0,
      items: [],
      note: expect.stringContaining("maintenance"),
    });
    expect(store.calls).toEqual([]);
  });

  it("marks a cheaper from-price only when it is really cheaper", async () => {
    const search = fixture<{ elements: Body[] }>("storefront-search");
    const first = search.elements[0];
    if (!first) throw new Error("fixture too small");
    first.calculatedCheapestPrice = { unitPrice: 800 };
    const store = storeApi({ search: () => HttpResponse.json(search as JsonBodyType) });
    mock.use(...adminSearches(), ...store.handlers);
    const result = await invoke(
      storefrontSearch,
      { term: "steel", salesChannel: "Headless", limit: 1 },
      ctx,
    );
    expect(result.items[0]).toMatchObject({ price: 918.39, fromPrice: 800 });
  });
});
