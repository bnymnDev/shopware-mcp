import { z } from "zod";
import { equals, type ShopwareFilter } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { notCancelled } from "./periods.js";
import { idSchema, num, raw, rawList, str } from "./shared.js";
import { defineTool } from "./types.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Below this many expected orders a quiet spell says nothing; small shops are often quiet. */
const MIN_EXPECTED = 3;
/** A payment state that means the customer tried and did not get through. */
const FAILED_STATES = new Set(["failed", "cancelled"]);

/* ------------------------------------------------------------------------------------------
 * Time zones without a library: Intl gives the wall clock, the offset follows from it.
 * ---------------------------------------------------------------------------------------- */

function wallClock(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const c = wallClock(date, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Local midnight of the day `date` falls on, in `timeZone`, as an instant. */
export function startOfDay(date: Date, timeZone: string): Date {
  const c = wallClock(date, timeZone);
  const midnightUtc = Date.UTC(c.year, c.month - 1, c.day);
  const guess = midnightUtc - offsetMs(date, timeZone);
  // The offset at midnight can differ from the one now (daylight saving changed during the day).
  return new Date(midnightUtc - offsetMs(new Date(guess), timeZone));
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const defaultTimeZone = (): string =>
  process.env.TZ && isTimeZone(process.env.TZ)
    ? process.env.TZ
    : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

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

export function silenceVerdict(minutes: number, expected: number): Verdict {
  if (minutes < 30 || expected < MIN_EXPECTED) return "normal";
  const chance = silenceChance(expected);
  if (chance < 0.01) return "unusual";
  if (chance < 0.05) return "watch";
  return "normal";
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
  const elapsed = now.getTime() - dayStart.getTime();
  const windows = Array.from({ length: weeks + 1 }, (_, weeksAgo) => {
    const from = startOfDay(new Date(now.getTime() - weeksAgo * WEEK_MS), timeZone);
    return { weeksAgo, from, to: new Date(from.getTime() + elapsed) };
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
  if (lastTime !== null) {
    // The same stretch of silence, one to `weeks` weeks earlier: how many orders came then?
    for (let weeksAgo = 1; weeksAgo <= weeks; weeksAgo++) {
      const from = new Date(lastTime - weeksAgo * WEEK_MS + 1000);
      const to = new Date(now.getTime() - weeksAgo * WEEK_MS);
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
    date: new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(window.from),
    orders: count(`o${window.weeksAgo}n`),
    revenue: round2(sum(`r${window.weeksAgo}s`)),
    payments: bucketCounts(aggs[`p${window.weeksAgo}t`]),
  }));
  const [today, ...previous] = history;
  if (!today) throw badRequest("No pulse window");
  const typicalOrders = mean(previous.map((week) => week.orders));
  const typicalRevenue = mean(previous.map((week) => week.revenue));

  const minutes = lastTime === null ? null : Math.floor((now.getTime() - lastTime) / 60_000);
  const sameGap = Array.from({ length: lastTime === null ? 0 : weeks }, (_, index) =>
    count(`g${index + 1}n`),
  );
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
