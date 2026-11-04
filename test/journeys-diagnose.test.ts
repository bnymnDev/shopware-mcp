import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnose, diagnosisText } from "../src/diagnose.js";
import { loadJourneys, runJourneys } from "../src/tools/journeys.js";
import { checkoutSimulate } from "../src/tools/storefront.js";
import { watchTick } from "../src/watch.js";
import { createContext, fixture, mock, SHOP_URL, searchHandler } from "./helpers/shopware.js";

const ctx = createContext();
type Simulation = Awaited<ReturnType<typeof checkoutSimulate.handler>>;

/** A cart as checkout_simulate returns it, with the parts a journey looks at. */
function cart(patch: Partial<Simulation> = {}): Simulation {
  return {
    salesChannel: { id: "c1", name: "Storefront" },
    as: { guest: true, shipsTo: "DE" },
    canOrder: true,
    currency: "EUR",
    taxStatus: "gross",
    items: [],
    promotions: [],
    shipping: { method: "Standard", costs: 4.9 },
    totals: { positions: 20, shipping: 4.9, net: 20.92, taxes: [], total: 24.9 },
    problems: [],
    paymentMethods: {
      selected: "Invoice",
      available: ["Invoice", "Paid in advance"],
      hidden: [{ name: "PayPal", reason: 'availability rule "Germany only" does not match' }],
    },
    shippingMethods: { selected: "Standard", available: ["Standard"], hidden: [] },
    cartDeleted: true,
    ...patch,
  } as Simulation;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("journeys", () => {
  it("names every expectation a journey broke, in words", async () => {
    vi.spyOn(checkoutSimulate, "handler")
      .mockResolvedValueOnce(cart())
      .mockResolvedValueOnce(
        cart({
          canOrder: false,
          problems: [
            {
              key: "shipping-address-blocked",
              level: "error",
              blocksOrder: true,
              message: "Shipping not possible",
              explanation: "Switzerland is not among the countries of Storefront (DE, GB)",
            },
            {
              key: "promotion-not-found",
              level: "error",
              blocksOrder: false,
              message: 'Promo code "SUMMER26" could not be found.',
              explanation: '"SUMMER26" belongs to "Summer Sale", but it ended on 2026-08-31',
            },
          ],
        }),
      )
      .mockRejectedValueOnce(new Error('product "SW1" not found'));
    const result = await runJourneys(ctx, [
      { name: "German guest", items: [{ productNumber: "SW10005" }], expect: { maxTotal: 30 } },
      {
        name: "Swiss guest with code",
        items: [{ productNumber: "SW10005" }],
        country: "CH",
        promotionCodes: ["SUMMER26"],
        expect: { paymentMethods: ["PayPal"] },
      },
      { name: "Old product", items: [{ productNumber: "SW1" }] },
    ]);
    expect(result).toMatchObject({ ok: false, passed: 1, failed: 2 });
    expect(result.results[1]?.failures).toEqual([
      "cannot order: Switzerland is not among the countries of Storefront (DE, GB)",
      'PayPal is not offered: availability rule "Germany only" does not match (offered: Invoice, Paid in advance)',
      'code SUMMER26 does not apply: "SUMMER26" belongs to "Summer Sale", but it ended on 2026-08-31',
    ]);
    expect(result.results[2]?.failures).toEqual(['could not run: product "SW1" not found']);
    // The journey's own inputs reach the cart, its name and expectations do not.
    expect(vi.mocked(checkoutSimulate.handler).mock.calls[1]?.[0]).toMatchObject({
      country: "CH",
      promotionCodes: ["SUMMER26"],
      items: [{ productNumber: "SW10005", quantity: 1 }],
    });
    expect(vi.mocked(checkoutSimulate.handler).mock.calls[1]?.[0]).not.toHaveProperty("expect");
  });

  it("reads journeys from a file and refuses a broken one", () => {
    const dir = mkdtempSync(join(tmpdir(), "swmcp-journeys-"));
    const good = join(dir, "good.json");
    writeFileSync(
      good,
      JSON.stringify({ journeys: [{ name: "a", items: [{ productNumber: "SW1" }] }] }),
    );
    expect(loadJourneys(good)).toHaveLength(1);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify([{ items: [] }]));
    expect(() => loadJourneys(bad)).toThrow(/Invalid journeys/);
  });
});

describe("diagnose", () => {
  it("collects the usual suspects and says what looked fine", async () => {
    vi.spyOn(checkoutSimulate, "handler").mockResolvedValue(cart());
    mock.use(
      searchHandler({
        "sales-channel": () => ({
          total: 2,
          data: [
            { id: "a", name: "Storefront", active: true, maintenance: true },
            { id: "b", name: "Outlet", active: true, maintenance: false },
          ],
        }),
        "order-line-item": () => ({
          total: 0,
          data: [],
          aggregations: { top: { buckets: [{ key: "SW10005", count: 12 }] } },
        }),
        plugin: () => ({
          total: 1,
          data: [
            {
              name: "SwagPayPal",
              version: "9.1.0",
              upgradedAt: "2026-11-27T10:00:00.000+00:00",
              installedAt: "2025-01-01T00:00:00.000+00:00",
            },
          ],
        }),
        "log-entry": () => ({
          total: 3,
          data: [
            {
              message: "mail.sent.error",
              context: { additionalData: { message: "Failed sending mail: Connection refused" } },
            },
          ],
          aggregations: { messages: { buckets: [{ key: "mail.sent.error", count: 3 }] } },
        }),
        "scheduled-task": () => ({ total: 0, data: [] }),
      }),
    );
    const result = await diagnose(ctx, new Date("2026-11-27T14:00:00.000Z"));
    expect(result.causes).toEqual([
      "Storefront is in maintenance mode: customers see the maintenance page",
      "Extensions changed in the last 24 hours: SwagPayPal updated 4 h ago (9.1.0)",
      "3 errors in Shopware's log in the last 6 hours: mail.sent.error (3). Latest: Failed sending mail: Connection refused",
    ]);
    expect(result.fine).toContain(
      'a test purchase of SW10005 works, payment: Invoice, Paid in advance; hidden: PayPal (availability rule "Germany only" does not match)',
    );
    expect(diagnosisText(result)).toMatch(/^\*Likely causes\*\n• Storefront is in maintenance/);
  });

  it("keeps going when a look is refused", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/:entity`, () =>
        HttpResponse.json({ errors: [{ status: "403", code: "DENIED" }] }, { status: 403 }),
      ),
    );
    const result = await diagnose(ctx);
    expect(result).toEqual({ causes: [], fine: [] });
    expect(diagnosisText(result)).toContain("No obvious cause found");
  });
});

describe("watch with journeys and a diagnosis", () => {
  it("raises the alarm for a broken journey and says why", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
        const body = (await request.clone().json()) as { sort?: unknown };
        const last = fixture<{ data: Array<Record<string, unknown>> }>("pulse-last-order");
        if (last.data[0]) last.data[0].orderDateTime = "2026-09-27T17:55:00.000+00:00";
        return HttpResponse.json(
          (body.sort ? last : fixture("pulse-aggregations")) as JsonBodyType,
        );
      }),
    );
    const tick = await watchTick(
      ctx.client,
      {
        timeZone: "Europe/Berlin",
        baseline: "recent",
        expectFactor: 1,
        journeys: async () => ({
          failed: 1,
          results: [
            { name: "German guest", ok: true, failures: [] },
            { name: "PayPal buyer", ok: false, failures: ["PayPal is not offered"] },
          ],
        }),
        diagnose: async () => "*Likely causes*\n• SwagPayPal updated 1 h ago",
      },
      null,
      new Date("2026-09-27T18:01:38.402Z"),
    );
    expect(tick.state.level).toBe("critical");
    expect(tick.alert).toBe(
      ":red_circle: *1 of 2 customer journeys broke*\n• PayPal buyer: PayPal is not offered\n" +
        "6 orders today (-35.1 %), last order 6 min ago.\n*Likely causes*\n• SwagPayPal updated 1 h ago",
    );
    expect(tick.line).toContain("journeys 1/2 ok");
  });
});
