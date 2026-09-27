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
import { shiftDays } from "../src/tools/zone.js";
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

describe("shiftDays", () => {
  it("keeps the local clock time when daylight saving changes in between", () => {
    // Monday 00:30 in Berlin, the day after clocks went forward: a week back is Monday 00:30 CET.
    expect(shiftDays(new Date("2026-03-29T22:30:00Z"), -7, "Europe/Berlin").toISOString()).toBe(
      "2026-03-22T23:30:00.000Z",
    );
    // Monday 23:30 in New York, a week after clocks went back: two weeks back is still Monday.
    expect(shiftDays(new Date("2026-11-10T04:30:00Z"), -14, "America/New_York").toISOString()).toBe(
      "2026-10-27T03:30:00.000Z",
    );
    expect(shiftDays(NOW, -7, "UTC").toISOString()).toBe("2026-09-20T18:01:38.402Z");
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

  it("compares the same weekday across daylight saving changes", async () => {
    const bodies: Body[] = [];
    mock.use(
      http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
        bodies.push((await request.clone().json()) as Body);
        return HttpResponse.json({ total: 0, data: [], aggregations: {} });
      }),
    );
    const berlin = await computePulse(ctx.client, {
      weeks: 2,
      timeZone: "Europe/Berlin",
      now: new Date("2026-03-29T22:30:00Z"),
    });
    expect(berlin.history.map((week) => week.date)).toEqual([
      "2026-03-30",
      "2026-03-23",
      "2026-03-16",
    ]);
    const lastWeek = bodies[1]?.aggregations?.find((agg) => agg.name === "o1");
    expect(JSON.stringify(lastWeek?.filter)).toContain(
      '"gte":"2026-03-22T23:00:00.000Z","lt":"2026-03-22T23:30:00.000Z"',
    );

    const newYork = await computePulse(ctx.client, {
      weeks: 3,
      timeZone: "America/New_York",
      now: new Date("2026-11-10T04:30:00Z"),
    });
    expect(newYork.history.map((week) => week.date)).toEqual([
      "2026-11-09",
      "2026-11-02",
      "2026-10-26",
      "2026-10-19",
    ]);
  });

  it("leaves out weeks whose stretch reaches into the silence itself", async () => {
    const { bodies, handler } = orderSearches();
    mock.use(
      http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
        const body = (await request.clone().json()) as Body;
        if (!body.sort) return undefined;
        const last = fixture<{ data: Array<Record<string, unknown>> }>("pulse-last-order");
        if (last.data[0]) last.data[0].orderDateTime = "2026-09-17T12:00:00.000+00:00";
        return HttpResponse.json(last as JsonBodyType);
      }),
      handler,
    );
    const pulse = await computePulse(ctx.client, { weeks: 4, timeZone: "UTC", now: NOW });
    const names = (bodies.find((body) => !body.sort)?.aggregations ?? []).map((agg) => agg.name);
    expect(names.filter((name) => String(name).startsWith("g"))).toEqual(["g2", "g3", "g4"]);
    expect(pulse.silence?.sameGapInPreviousWeeks).toHaveLength(3);
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
