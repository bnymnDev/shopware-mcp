import { HttpResponse, http, type JsonBodyType } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shopAudit } from "../src/tools/audit.js";
import {
  computePulse,
  shopPulse,
  silenceChance,
  silenceVerdict,
  startOfDay,
} from "../src/tools/pulse.js";
import { createContext, fixture, invoke, mock, SHOP_URL } from "./helpers/shopware.js";

const ctx = createContext();
const NOW = new Date("2026-09-27T18:01:38.402Z");
type Body = { sort?: unknown; aggregations?: Array<Record<string, unknown>> };

/** Order searches answered from a real shop: the last order, then the windowed aggregations. */
function orderSearches(aggregations: () => unknown = () => fixture("pulse-aggregations")) {
  const bodies: Body[] = [];
  const handler = http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
    const body = (await request.clone().json()) as Body;
    bodies.push(body);
    return HttpResponse.json(
      (body.sort ? fixture("pulse-last-order") : aggregations()) as JsonBodyType,
    );
  });
  return { bodies, handler };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startOfDay", () => {
  it("finds local midnight, across daylight saving changes", () => {
    expect(startOfDay(NOW, "Europe/Berlin").toISOString()).toBe("2026-09-26T22:00:00.000Z");
    expect(startOfDay(new Date("2026-10-25T12:00:00Z"), "Europe/Berlin").toISOString()).toBe(
      "2026-10-24T22:00:00.000Z",
    );
    expect(startOfDay(new Date("2026-03-29T12:00:00Z"), "Europe/Berlin").toISOString()).toBe(
      "2026-03-28T23:00:00.000Z",
    );
    expect(startOfDay(new Date("2026-09-27T03:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-09-26T04:00:00.000Z",
    );
    expect(startOfDay(NOW, "UTC").toISOString()).toBe("2026-09-27T00:00:00.000Z");
  });
});

describe("silence verdict", () => {
  it("only calls a quiet spell unusual when orders were really expected", () => {
    expect(silenceChance(4.625)).toBeCloseTo(0.0098, 4);
    expect(silenceVerdict(359, 4.625)).toBe("unusual");
    expect(silenceVerdict(359, 4.6)).toBe("watch");
    expect(silenceVerdict(359, 3.5)).toBe("watch");
    expect(silenceVerdict(359, 2.9)).toBe("normal");
    expect(silenceVerdict(20, 9)).toBe("normal");
  });
});

describe("shop_pulse", () => {
  it("compares today with the same hours of previous weeks and weighs the silence", async () => {
    const { bodies, handler } = orderSearches();
    mock.use(handler);
    const pulse = await computePulse(ctx.client, { weeks: 8, timeZone: "Europe/Berlin", now: NOW });

    const [last, windows] = bodies;
    expect(last).toMatchObject({ limit: 1, sort: [{ field: "orderDateTime", order: "DESC" }] });
    const aggs = windows?.aggregations ?? [];
    expect(aggs).toHaveLength(9 * 3 + 8);
    expect(aggs[0]).toMatchObject({
      name: "o0",
      type: "filter",
      aggregation: { type: "count", field: "id" },
    });
    expect(JSON.stringify(aggs[0]?.filter)).toContain(
      '"gte":"2026-09-26T22:00:00.000Z","lt":"2026-09-27T18:01:38.402Z"',
    );
    expect(JSON.stringify(aggs[0]?.filter)).toContain('"cancelled"');
    expect(JSON.stringify(aggs[3]?.filter)).toContain('"gte":"2026-09-19T22:00:00.000Z"');
    const gap = aggs.find((agg) => agg.name === "g1");
    expect(JSON.stringify(gap?.filter)).toContain(
      '"gte":"2026-09-20T12:01:52.000Z","lt":"2026-09-20T18:01:38.402Z"',
    );
    expect(JSON.stringify(gap?.filter)).not.toContain("cancelled");

    expect(pulse).toMatchObject({
      timeZone: "Europe/Berlin",
      today: { since: "2026-09-26T22:00:00.000Z", orders: 6, revenue: 142679.2 },
      typical: { weeks: 8, orders: 9.3, ordersRange: { min: 8, max: 11 } },
      change: { orders: -35.1 },
      lastOrder: { orderNumber: "10759", minutesAgo: 359 },
      silence: {
        minutes: 359,
        expectedOrders: 4.6,
        sameGapInPreviousWeeks: [6, 4, 3, 5, 3, 5, 5, 6],
        chance: 0.0098,
        verdict: "unusual",
      },
      payments: { today: { failedOrCancelled: 0, total: 6 }, verdict: "normal" },
    });
    expect(pulse.history.map((week) => week.date)).toEqual([
      "2026-09-27",
      "2026-09-20",
      "2026-09-13",
      "2026-09-06",
      "2026-08-30",
      "2026-08-23",
      "2026-08-16",
      "2026-08-09",
      "2026-08-02",
    ]);
    expect(pulse.history[0]).not.toHaveProperty("payments");
  });

  it("flags a run of failed payments against their usual share", async () => {
    const aggregations = () => {
      const response = fixture<{ aggregations: Record<string, unknown> }>("pulse-aggregations");
      response.aggregations.p0t = {
        buckets: [
          { key: "paid", count: 2 },
          { key: "failed", count: 3 },
          { key: "cancelled", count: 1 },
        ],
      };
      return response;
    };
    const { handler } = orderSearches(aggregations);
    mock.use(handler);
    const pulse = await computePulse(ctx.client, { weeks: 8, timeZone: "Europe/Berlin", now: NOW });
    expect(pulse.payments).toMatchObject({
      today: { failedOrCancelled: 4, total: 6 },
      verdict: "unusual",
    });
  });

  it("has nothing to weigh in a shop without orders", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/order`, () =>
        HttpResponse.json({ total: 0, data: [], aggregations: {} }),
      ),
    );
    const pulse = await computePulse(ctx.client, { weeks: 4, timeZone: "UTC", now: NOW });
    expect(pulse).toMatchObject({
      today: { orders: 0, revenue: 0 },
      typical: { orders: 0 },
      change: { orders: null },
      lastOrder: null,
      silence: null,
      payments: { verdict: "normal" },
    });
  });

  it("scopes every window to one sales channel and rejects unknown time zones", async () => {
    const { bodies, handler } = orderSearches();
    mock.use(handler);
    await invoke(
      shopPulse,
      { weeks: 2, timeZone: "Europe/Berlin", salesChannelId: "98432def39fc4624b33213a56b8c944d" },
      ctx,
    );
    expect(JSON.stringify(bodies[0])).toContain("salesChannelId");
    for (const agg of bodies[1]?.aggregations ?? []) {
      expect(JSON.stringify(agg.filter)).toContain('"salesChannelId"');
    }
    await expect(invoke(shopPulse, { timeZone: "Mars/Olympus" }, ctx)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("shop_audit checkout_silent", () => {
  it("raises a critical finding when the quiet spell is unusual", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { handler } = orderSearches();
    mock.use(handler);
    const audit = await invoke(shopAudit, {}, ctx);
    const silent = audit.findings.find((finding) => finding.id === "checkout_silent");
    expect(silent).toMatchObject({
      severity: "critical",
      count: 1,
      items: [
        {
          lastOrder: "10759",
          minutesWithoutOrder: 359,
          expectedOrders: 4.6,
          chance: 0.0098,
        },
      ],
      hint: expect.stringContaining("checkout_simulate"),
    });
  });
});
