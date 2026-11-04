import { HttpResponse, http, type JsonBodyType } from "msw";
import { describe, expect, it } from "vitest";
import { returnsReport } from "../src/tools/returns.js";
import {
  createContext,
  fixture,
  invoke,
  mock,
  SHOP_URL,
  searchHandler,
} from "./helpers/shopware.js";

const ctx = createContext();
type Body = { filter?: unknown[]; aggregations?: unknown[] };

/** A real shop's answers: order totals per period, then line items in returned and in all orders. */
function shop() {
  const bodies: Record<string, Body[]> = { order: [], "order-line-item": [] };
  const handlers = [
    http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
      const body = (await request.clone().json()) as Body;
      bodies.order?.push(body);
      // Every test asks for a period from 2026-08-01; the period before it ends earlier.
      const end = /"lte":"([^"]+)"/.exec(JSON.stringify(body.filter))?.[1] ?? "";
      const previous = end < "2026-08-01";
      return HttpResponse.json(
        fixture<JsonBodyType>(previous ? "returns-orders-previous" : "returns-orders"),
      );
    }),
    http.post(`${SHOP_URL}/api/search/order-line-item`, async ({ request }) => {
      const body = (await request.clone().json()) as Body;
      bodies["order-line-item"]?.push(body);
      const returned = JSON.stringify(body.filter).includes("returned_partially");
      return HttpResponse.json(
        fixture<JsonBodyType>(returned ? "returns-items-returned" : "returns-items-all"),
      );
    }),
    searchHandler({ product: "returns-products" }),
  ];
  return { bodies, handlers };
}

describe("returns_report", () => {
  it("ranks products by the share of their orders that came back", async () => {
    const { bodies, handlers } = shop();
    mock.use(...handlers);
    const result = await invoke(
      returnsReport,
      { from: "2026-08-01", to: "2026-11-04", minOrders: 2 },
      ctx,
    );
    expect(result.totals).toEqual({
      orders: 12,
      returnedOrders: 4,
      partially: 1,
      returnRate: 33.33,
      returnedRevenue: 2898,
    });
    expect(result.products).toEqual([
      {
        productId: "11dc680240b04f469ccba354cbf0b967",
        productNumber: "SWDEMO10002",
        name: "Main product with advanced prices",
        orders: 5,
        returnedOrders: 4,
        returnRate: 80,
      },
      expect.objectContaining({ productNumber: "SWDEMO10006", orders: 6, returnRate: 16.67 }),
    ]);
    expect(result.note).toContain("per delivery, not per item");

    // Cancelled orders stay out, returns are read from the delivery state.
    const orderFilter = JSON.stringify(bodies.order?.[0]?.filter);
    expect(orderFilter).toContain('"cancelled"');
    expect(JSON.stringify(bodies.order?.[0]?.aggregations)).toContain(
      '"deliveries.stateMachineState.technicalName","value":["returned","returned_partially"]',
    );
    // All orders are counted only for the products that came back at least once.
    const all = bodies["order-line-item"]?.find(
      (body) => !JSON.stringify(body.filter).includes("returned"),
    );
    expect(JSON.stringify(all?.filter)).toContain(
      '"productId","value":["11dc680240b04f469ccba354cbf0b967"',
    );
  });

  it("leaves out products with too few orders to say anything", async () => {
    mock.use(...shop().handlers);
    const result = await invoke(
      returnsReport,
      { from: "2026-08-01", to: "2026-11-04", minOrders: 6 },
      ctx,
    );
    expect(result.products.map((product) => product.productNumber)).toEqual(["SWDEMO10006"]);
  });

  it("answers for a shop without returns without asking for products", async () => {
    mock.use(
      searchHandler({
        order: () => ({ total: 3, data: [], aggregations: {} }),
        "order-line-item": () => ({
          total: 0,
          data: [],
          aggregations: { byProduct: { buckets: [] } },
        }),
      }),
    );
    const result = await invoke(returnsReport, {}, ctx);
    expect(result).toMatchObject({
      totals: { orders: 3, returnedOrders: 0, returnRate: 0 },
      products: [],
    });
  });
});
