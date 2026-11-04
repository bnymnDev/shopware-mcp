import { HttpResponse, http, type JsonBodyType } from "msw";
import { describe, expect, it } from "vitest";
import { checkMargins, discountOn, promotionImpact } from "../src/tools/margins.js";
import { createContext, fixture, mock, SHOP_URL, searchHandler } from "./helpers/shopware.js";

const ctx = createContext();
const NOW = new Date("2026-11-04T18:27:27.100Z");

/** Real orders of a shop; a search for orders with a promotion line answers with `withCodes`. */
function orders(withCodes = 2) {
  return http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
    const body = JSON.stringify(await request.clone().json());
    if (body.includes("lineItems.type")) return HttpResponse.json({ total: withCodes, data: [] });
    return HttpResponse.json(fixture<JsonBodyType>("impact-orders"));
  });
}

describe("discountOn", () => {
  it("caps percentages and never takes more than the cart is worth", () => {
    expect(discountOn(800, { type: "percentage", value: 20 })).toBe(160);
    expect(discountOn(800, { type: "percentage", value: 20, maxValue: 100 })).toBe(100);
    expect(discountOn(30, { type: "absolute", value: 50 })).toBe(30);
    expect(discountOn(0, { type: "absolute", value: 5 })).toBe(0);
  });
});

describe("promotion_impact", () => {
  it("replays a discount on the real orders: every order, and the usual code uptake", async () => {
    mock.use(orders());
    const result = await promotionImpact(
      ctx.client,
      { discount: { type: "percentage", value: 20, maxValue: 100 }, minCartValue: 50, days: 30 },
      NOW,
    );
    expect(result).toMatchObject({
      orders: 8,
      revenue: 4271.9,
      eligibleOrders: 6,
      scenarios: {
        everyEligibleOrder: { cost: 599.19, shareOfRevenue: 14.03 },
        usualCodeUptake: { share: 25, cost: 149.8, shareOfRevenue: 3.51 },
      },
      averagePerOrder: 99.87,
      capReached: 5,
    });
    expect(result.note).toContain("upper bound");
  });

  it("reads an automatic promotion's discounts and channels, and names what it cannot model", async () => {
    let orderFilter = "";
    mock.use(
      http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
        const body = JSON.stringify(await request.clone().json());
        if (!body.includes("lineItems.type")) orderFilter = body;
        return HttpResponse.json(
          body.includes("lineItems.type")
            ? { total: 0, data: [] }
            : fixture<JsonBodyType>("impact-orders"),
        );
      }),
      searchHandler({
        promotion: () => ({
          total: 1,
          data: [
            {
              id: "p1",
              name: "Autumn 10 %",
              useCodes: false,
              discounts: [
                { type: "percentage", scope: "cart", value: 10 },
                { type: "absolute", scope: "delivery", value: 5 },
              ],
              salesChannels: [{ salesChannelId: "c1" }],
              personaRules: [{ id: "r1" }],
              cartRules: [],
            },
          ],
        }),
      }),
    );
    const result = await promotionImpact(ctx.client, { promotionId: "p1", days: 30 }, NOW);
    expect(result.promotion).toEqual({ id: "p1", name: "Autumn 10 %" });
    expect(result.scenarios).not.toHaveProperty("usualCodeUptake");
    expect(result.scenarios.everyEligibleOrder).toEqual({ cost: 427.19, shareOfRevenue: 10 });
    expect(orderFilter).toContain('"salesChannelId","value":["c1"]');
    expect(result.note).toContain(
      "Not modelled: absolute discount on delivery, rules that limit who gets it.",
    );
    expect(result.note).toContain("applies automatically");
  });

  it("needs a promotion or a discount", async () => {
    await expect(promotionImpact(ctx.client, { days: 30 })).rejects.toMatchObject({ status: 400 });
  });
});

describe("margin_check", () => {
  it("finds products below cost and thin ones, and what the running discount leaves", async () => {
    mock.use(
      searchHandler({
        product: () => fixture("margin-products"),
        promotion: () => fixture("margin-promotions"),
      }),
    );
    const result = await checkMargins(ctx.client, { minMargin: 15, maxItems: 10 }, NOW);
    expect(result).toMatchObject({
      checked: 13,
      withoutPurchasePrice: 10,
      automaticDiscount: { name: "Autumn 10 % for everyone", percent: 10 },
      summary: { belowCost: 1, thin: 1, lossWithDiscount: 0 },
    });
    expect(result.belowCost[0]).toEqual({
      productNumber: "SWDEMO10006",
      name: "Main product, free shipping with highlighting",
      net: 15,
      purchaseNet: 30,
      margin: -100,
      marginAfterDiscount: -122.22,
    });
    expect(result.thin[0]).toMatchObject({
      productNumber: "SWDEMO10002",
      margin: 12.32,
      marginAfterDiscount: 2.57,
    });
    // With a stricter threshold the thin product moves, the one below cost stays.
    const strict = await checkMargins(ctx.client, { minMargin: 5, maxItems: 10 }, NOW);
    expect(strict.summary).toMatchObject({ belowCost: 1, thin: 0 });
  });

  it("flags what an automatic discount pushes below cost", async () => {
    const promotions = fixture<{ data: Array<{ discounts: Array<{ value: number }> }> }>(
      "margin-promotions",
    );
    const first = promotions.data[0]?.discounts[0];
    if (first) first.value = 20;
    mock.use(
      searchHandler({ product: () => fixture("margin-products"), promotion: () => promotions }),
    );
    const result = await checkMargins(ctx.client, { minMargin: 15, maxItems: 10 }, NOW);
    expect(result.lossWithDiscount.map((row) => row.productNumber)).toEqual(["SWDEMO10002"]);
  });
});
