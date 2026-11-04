import { HttpResponse, http, type JsonBodyType } from "msw";
import { describe, expect, it } from "vitest";
import { agentReadiness, buildFeed, plainText, validGtin } from "../src/tools/feed.js";
import { createContext, fixture, mock, SHOP_URL } from "./helpers/shopware.js";

const ctx = createContext();

/** The searches of a real dockware shop (6.7.2.2) and its legal pages. */
function shop(config: Record<string, unknown> | null = LEGAL) {
  return [
    http.post(`${SHOP_URL}/api/search/sales-channel`, () =>
      HttpResponse.json(fixture<JsonBodyType>("feed-sales-channel")),
    ),
    http.post(`${SHOP_URL}/api/search/product`, async ({ request }) => {
      const body = JSON.stringify(await request.clone().json());
      return HttpResponse.json(
        fixture<JsonBodyType>(body.includes('"includes"') ? "feed-parents" : "feed-products"),
      );
    }),
    http.get(`${SHOP_URL}/api/_action/system-config`, () =>
      config
        ? HttpResponse.json(config)
        : HttpResponse.json({ errors: [{ status: "403", code: "DENIED" }] }, { status: 403 }),
    ),
  ];
}

const LEGAL = {
  "core.basicInformation.shopName": "Demostore",
  "core.basicInformation.privacyPage": "p1",
  "core.basicInformation.tosPage": "t1",
  "core.basicInformation.revocationPage": "r1",
};

describe("feed helpers", () => {
  it("checks a GTIN's length and check digit", () => {
    expect(validGtin("4006381333931")).toBe(true);
    expect(validGtin("4006381333932")).toBe(false);
    expect(validGtin("73513537")).toBe(true);
    expect(validGtin("400638133393")).toBe(false);
    expect(validGtin("40063813339a1")).toBe(false);
  });

  it("turns a description's HTML into plain text", () => {
    expect(plainText("<p>Soft&nbsp;cotton</p><ul><li>Blue</li><li>M &amp; L</li></ul>")).toBe(
      "Soft cotton\nBlue\nM & L",
    );
  });
});

describe("agent_readiness", () => {
  it("builds the feed agents read and names what is missing", async () => {
    mock.use(...shop());
    const feed = await buildFeed(ctx.client, {});
    expect(feed.rows).toHaveLength(13);
    const variant = feed.rows.find((row) => row.item_id === "SWDEMO10005.1");
    expect(variant).toMatchObject({
      title: "Variant product Blue M",
      price: "19.99 EUR",
      availability: "in_stock",
      brand: "Shopware Fashion",
      seller_name: "Demostore",
      group_id: "SWDEMO10005",
      listing_has_variations: true,
      variant_dict: { Colour: "Blue", Size: "M" },
      seller_privacy_policy: "http://localhost/widgets/cms/p1",
    });
    expect(variant?.url).toMatch(/^http:\/\/localhost\/Variant-product\/SWDEMO10005\.1$/);

    const result = await agentReadiness(ctx.client, { maxItems: 2 });
    expect(result.products).toEqual({ checked: 13, readyForDiscovery: 13, readyShare: 100 });
    expect(result.gaps.map((gap) => [gap.field, gap.count])).toEqual([
      ["gtin", 13],
      ["mpn", 13],
      ["weight", 4],
    ]);
    expect(result.shop.find((check) => check.check === "https")).toMatchObject({ ok: false });
    expect(result.checkoutReady).toBe(false);
    expect(result.score).toBe(88);
    expect(result.feedSample[0]?.description.length).toBeLessThanOrEqual(301);
  });

  it("still checks the products when the role cannot read the legal pages", async () => {
    mock.use(...shop(null));
    const result = await agentReadiness(ctx.client, { maxItems: 1 });
    expect(result.products.checked).toBe(13);
    expect(result.shop.find((check) => check.check === "terms")?.detail).toContain(
      "system_config:read",
    );
  });
});
