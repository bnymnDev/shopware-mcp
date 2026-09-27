import { z } from "zod";
import { equals, type ShopwareFilter } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { notCancelled } from "./periods.js";
import { idSchema, num, raw, rawList, str } from "./shared.js";
import { defineTool } from "./types.js";
import { defaultTimeZone, isTimeZone, localDate, shiftDays, startOfDay } from "./zone.js";

export { defaultTimeZone, isTimeZone, startOfDay } from "./zone.js";

/** Below this many expected orders a quiet spell says nothing; small shops are often quiet. */
const MIN_EXPECTED = 3;
/** A payment state that means the customer tried and did not get through. */
const FAILED_STATES = new Set(["failed", "cancelled"]);

/* ------------------------------------------------------------------------------------------
 * The pulse
 * ---------------------------------------------------------------------------------------- */

export type Verdict = "normal" | "watch" | "unusual";

export interface PulseOptions {
  weeks: number;
  timeZone: string;
  salesChannelId?: string | undefined;
  now?: Date;
}

const range = (from: Date, to: Date): ShopwareFilter => ({
  type: "range",
  field: "orderDateTime",
  parameters: { gte: from.toISOString(), lt: to.toISOString() },
});

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const pct = (value: number, base: number) =>
  base === 0 ? null : Math.round(((value - base) / base) * 1000) / 10;

/** Chance of seeing no order at all in a window where `expected` arrive on average (Poisson). */
export function silenceChance(expected: number): number {
  return Math.exp(-expected);
}

/** From MIN_EXPECTED orders on, the chance of none is below 5 % (e^-3), so at least "watch". */
export function silenceVerdict(minutes: number, expected: number): Verdict {
  if (minutes < 30 || expected < MIN_EXPECTED) return "normal";
  return silenceChance(expected) < 0.01 ? "unusual" : "watch";
}

function bucketCounts(aggregation: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bucket of rawList(raw(aggregation)?.buckets)) {
    const key = str(bucket.key);
    if (key) counts.set(key, num(bucket.count) ?? 0);
  }
  return counts;
}

export async function computePulse(client: ShopwareClient, options: PulseOptions) {
  const now = options.now ?? new Date();
  const { weeks, timeZone } = options;
  const scope: ShopwareFilter[] = options.salesChannelId
    ? [equals("salesChannelId", options.salesChannelId)]
    : [];

  const last = await client.search<Raw>("order", {
    page: 1,
    limit: 1,
    filter: scope,
    sort: [{ field: "orderDateTime", order: "DESC" }],
    includes: { order: ["id", "orderNumber", "orderDateTime"] },
  });
  const lastOrder = last.items[0];
  const lastAt = str(lastOrder?.orderDateTime);
  const lastTime = lastAt ? Date.parse(lastAt) : null;

  const dayStart = startOfDay(now, timeZone);
  // Same weekday, same clock time, stepped on the local calendar: across a daylight saving
  // change a week is not 168 hours.
  const weekBack = (date: Date, weeksAgo: number) =>
    weeksAgo === 0 ? date : shiftDays(date, -7 * weeksAgo, timeZone);
  const windows = Array.from({ length: weeks + 1 }, (_, weeksAgo) => {
    const to = weekBack(now, weeksAgo);
    return { weeksAgo, from: startOfDay(to, timeZone), to };
  });

  const aggregations: Raw[] = [];
  for (const window of windows) {
    const sold = [...scope, notCancelled(), range(window.from, window.to)];
    const all = [...scope, range(window.from, window.to)];
    aggregations.push(
      {
        name: `o${window.weeksAgo}`,
        type: "filter",
        filter: sold,
        aggregation: { name: `o${window.weeksAgo}n`, type: "count", field: "id" },
      },
      {
        name: `r${window.weeksAgo}`,
        type: "filter",
        filter: sold,
        aggregation: { name: `r${window.weeksAgo}s`, type: "sum", field: "amountTotal" },
      },
      {
        name: `p${window.weeksAgo}`,
        type: "filter",
        filter: all,
        aggregation: {
          name: `p${window.weeksAgo}t`,
          type: "terms",
          field: "transactions.stateMachineState.technicalName",
        },
      },
    );
  }
  // The same stretch of silence, one to `weeks` weeks earlier: how many orders came then? A
  // week whose stretch reaches into the silence itself is no comparison and is left out.
  const gapWeeks: number[] = [];
  if (lastTime !== null) {
    for (let weeksAgo = 1; weeksAgo <= weeks; weeksAgo++) {
      const from = new Date(weekBack(new Date(lastTime), weeksAgo).getTime() + 1000);
      const to = weekBack(now, weeksAgo);
      if (to.getTime() > lastTime) continue;
      gapWeeks.push(weeksAgo);
      aggregations.push({
        name: `g${weeksAgo}`,
        type: "filter",
        filter: [...scope, range(from, to)],
        aggregation: { name: `g${weeksAgo}n`, type: "count", field: "id" },
      });
    }
  }

  const result = await client.search<Raw>("order", {
    page: 1,
    limit: 1,
    "total-count-mode": 0,
    includes: { order: ["id"] },
    aggregations,
  });
  const aggs = result.aggregations;
  const count = (name: string) => num(raw(aggs[name])?.count) ?? 0;
  const sum = (name: string) => num(raw(aggs[name])?.sum) ?? 0;

  const history = windows.map((window) => ({
    weeksAgo: window.weeksAgo,
    date: localDate(window.from, timeZone),
    orders: count(`o${window.weeksAgo}n`),
    revenue: round2(sum(`r${window.weeksAgo}s`)),
    payments: bucketCounts(aggs[`p${window.weeksAgo}t`]),
  }));
  const [today, ...previous] = history;
  if (!today) throw badRequest("No pulse window");
  const typicalOrders = mean(previous.map((week) => week.orders));
  const typicalRevenue = mean(previous.map((week) => week.revenue));

  const minutes = lastTime === null ? null : Math.floor((now.getTime() - lastTime) / 60_000);
  const sameGap = gapWeeks.map((weeksAgo) => count(`g${weeksAgo}n`));
  const expected = mean(sameGap);

  const failedOf = (payments: Map<string, number>) =>
    [...payments].filter(([state]) => FAILED_STATES.has(state)).reduce((n, [, c]) => n + c, 0);
  const totalOf = (payments: Map<string, number>) =>
    [...payments.values()].reduce((n, value) => n + value, 0);
  const failedToday = failedOf(today.payments);
  const paymentsToday = totalOf(today.payments);
  const failedBefore = previous.reduce((n, week) => n + failedOf(week.payments), 0);
  const paymentsBefore = previous.reduce((n, week) => n + totalOf(week.payments), 0);
  const typicalShare = paymentsBefore === 0 ? 0 : failedBefore / paymentsBefore;
  const shareToday = paymentsToday === 0 ? 0 : failedToday / paymentsToday;
  const paymentVerdict: Verdict =
    failedToday >= 3 && shareToday >= Math.max(2 * typicalShare, typicalShare + 0.1)
      ? "unusual"
      : failedToday >= 2 && shareToday >= Math.max(1.5 * typicalShare, typicalShare + 0.05)
        ? "watch"
        : "normal";

  return {
    now: now.toISOString(),
    timeZone,
    salesChannelId: options.salesChannelId ?? null,
    today: {
      since: dayStart.toISOString(),
      orders: today.orders,
      revenue: today.revenue,
    },
    typical: {
      weeks,
      orders: round1(typicalOrders),
      revenue: round2(typicalRevenue),
      ordersRange: {
        min: Math.min(...previous.map((week) => week.orders)),
        max: Math.max(...previous.map((week) => week.orders)),
      },
    },
    change: {
      orders: pct(today.orders, typicalOrders),
      revenue: pct(today.revenue, typicalRevenue),
    },
    lastOrder:
      lastOrder && lastAt
        ? { orderNumber: str(lastOrder.orderNumber), at: lastAt, minutesAgo: minutes }
        : null,
    silence:
      minutes === null
        ? null
        : {
            minutes,
            expectedOrders: round1(expected),
            sameGapInPreviousWeeks: sameGap,
            chance: Number(silenceChance(expected).toPrecision(2)),
            verdict: silenceVerdict(minutes, expected),
          },
    payments: {
      today: { failedOrCancelled: failedToday, total: paymentsToday },
      typicalFailedShare: round2(typicalShare),
      verdict: paymentVerdict,
    },
    history: history.map(({ payments: _payments, ...week }) => week),
  };
}

export type Pulse = Awaited<ReturnType<typeof computePulse>>;

/** "the last 8 Sundays" when every week was compared, "7 earlier Sundays" when some were not. */
export function comparedWeeks(pulse: Pulse, unit: string): string {
  const compared = pulse.silence?.sameGapInPreviousWeeks.length ?? 0;
  const plural = `${unit}${compared === 1 ? "" : "s"}`;
  return compared === pulse.typical.weeks
    ? `the last ${compared} ${plural}`
    : `${compared} earlier ${plural}`;
}

export const shopPulse = defineTool({
  name: "shop_pulse",
  title: "Shop pulse",
  description:
    "How is the shop doing right now? Orders and revenue since local midnight next to the " +
    "same hours of the same weekday in previous weeks, the last order, and how unusual the " +
    "current quiet spell is: the orders the same stretch brought in earlier weeks and the " +
    "chance of seeing none by accident (a Poisson estimate). 'unusual' means the checkout, " +
    "payment or storefront may be broken; follow up with checkout_simulate. Also compares " +
    "today's failed or cancelled payments with their usual share. Read-only. Returns { today, " +
    "typical, change, lastOrder, silence, payments, history[] }.",
  inputSchema: {
    weeks: z
      .number()
      .int()
      .min(2)
      .max(12)
      .default(8)
      .describe("How many previous weeks make up 'typical'"),
    timeZone: z
      .string()
      .trim()
      .optional()
      .describe("IANA time zone of the shop, e.g. Europe/Berlin; default: the server's"),
    salesChannelId: idSchema.optional().describe("Only this sales channel"),
  },
  handler: async (input, ctx) => {
    const timeZone = input.timeZone ?? defaultTimeZone();
    if (!isTimeZone(timeZone)) throw badRequest(`Unknown time zone "${timeZone}"`);
    return computePulse(ctx.client, {
      weeks: input.weeks,
      timeZone,
      salesChannelId: input.salesChannelId,
    });
  },
});
