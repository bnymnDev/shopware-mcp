import { z } from "zod";
import { equals, type ShopwareFilter } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { HOLIDAY_COUNTRIES, type HolidayCountry, holidayCountryOf, holidayOn } from "./holidays.js";
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
export type Baseline = "recent" | "last-year";

/** The weeks back a baseline compares with. Last year: 52 weeks back keeps the weekday. */
export function baselineWeeks(baseline: Baseline, weeks: number): number[] {
  return baseline === "last-year"
    ? [51, 52, 53]
    : Array.from({ length: weeks }, (_, index) => index + 1);
}

export interface PulseOptions {
  weeks: number;
  /**
   * What "usual" means: the same weekday of the last `weeks` weeks, or the same weekday around
   * this day last year (51 to 53 weeks back), which is what a campaign day compares with.
   */
  baseline?: Baseline;
  /** Today is expected to bring this many times the usual orders, e.g. 3 on Black Friday. */
  expectFactor?: number;
  timeZone: string;
  /**
   * Leave compared days that were public holidays in this country out of "usual"; default: the
   * country of the time zone (Europe/Berlin: DE), "none" to keep every day.
   */
  holidays?: HolidayCountry | "none" | undefined;
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
  const baseline = options.baseline ?? "recent";
  const factor = options.expectFactor ?? 1;
  const country =
    options.holidays === "none" ? null : (options.holidays ?? holidayCountryOf(timeZone));
  // Same weekday, same clock time, stepped on the local calendar: across a daylight saving
  // change a week is not 168 hours.
  const weekBack = (date: Date, weeksAgo: number) =>
    weeksAgo === 0 ? date : shiftDays(date, -7 * weeksAgo, timeZone);
  // A holiday in the compared weeks would drag "usual" down (or up, before Christmas): it
  // is left out, as long as one week remains to compare with.
  const skippedHolidays: Array<{ date: string; name: string }> = [];
  const allOffsets = baselineWeeks(baseline, weeks);
  const offsets = allOffsets.filter((weeksAgo) => {
    const date = localDate(weekBack(now, weeksAgo), timeZone);
    const name = holidayOn(date, country);
    if (name) skippedHolidays.push({ date, name });
    return !name;
  });
  if (offsets.length === 0) {
    offsets.push(...allOffsets);
    skippedHolidays.length = 0;
  }
  const todayHoliday = holidayOn(localDate(now, timeZone), country);
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
  const windows = [0, ...offsets].map((weeksAgo) => {
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
    for (const weeksAgo of offsets) {
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
  // A campaign day is expected to bring more: the factor raises what "usual" means today.
  const typicalOrders = mean(previous.map((week) => week.orders)) * factor;
  const typicalRevenue = mean(previous.map((week) => week.revenue)) * factor;

  const minutes = lastTime === null ? null : Math.floor((now.getTime() - lastTime) / 60_000);
  const sameGap = gapWeeks.map((weeksAgo) => count(`g${weeksAgo}n`));
  const expected = mean(sameGap) * factor;

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
      ...(todayHoliday ? { holiday: todayHoliday } : {}),
    },
    typical: {
      weeks: offsets.length,
      baseline,
      expectFactor: factor,
      orders: round1(typicalOrders),
      revenue: round2(typicalRevenue),
      ordersRange: {
        min: Math.min(...previous.map((week) => week.orders)),
        max: Math.max(...previous.map((week) => week.orders)),
      },
      ...(skippedHolidays.length > 0 ? { skippedHolidays } : {}),
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
            comparedWeeksAgo: gapWeeks,
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
  if (pulse.typical.baseline === "last-year")
    return `${compared} ${plural} around this day last year`;
  return compared === pulse.typical.weeks
    ? `the last ${compared} ${plural}`
    : `${compared} earlier ${plural}`;
}

/** What "usual" was, in words: "the last 8 Sundays" or "the Sundays around this day last year". */
export function baselineText(pulse: Pulse, day: string): string {
  const base =
    pulse.typical.baseline === "last-year"
      ? `the ${day}s around this day last year`
      : `the last ${pulse.typical.weeks} ${day}s`;
  return pulse.typical.expectFactor === 1 ? base : `${base}, times ${pulse.typical.expectFactor}`;
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
    "today's failed or cancelled payments with their usual share. On a campaign day compare " +
    "with last year (baseline 'last-year') or raise the expectation (expectFactor 3 on Black " +
    "Friday), so a quiet spell is judged against what the day should bring. Public holidays in " +
    "the compared weeks are left out (DE, AT, CH). Read-only. Returns { today, " +
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
    baseline: z
      .enum(["recent", "last-year"])
      .default("recent")
      .describe("Compare with recent weeks, or with the same weekday around this day last year"),
    expectFactor: z
      .number()
      .min(0.1)
      .max(20)
      .default(1)
      .describe("Today should bring this many times the usual orders, e.g. 3 on a campaign day"),
    holidays: z
      .enum([...HOLIDAY_COUNTRIES, "none"])
      .optional()
      .describe(
        "Leave public holidays of this country out of 'typical'; default: the time zone's " +
          "country (Europe/Berlin: DE, Europe/Vienna: AT, Europe/Zurich: CH)",
      ),
  },
  handler: async (input, ctx) => {
    const timeZone = input.timeZone ?? defaultTimeZone();
    if (!isTimeZone(timeZone)) throw badRequest(`Unknown time zone "${timeZone}"`);
    return computePulse(ctx.client, {
      weeks: input.weeks,
      timeZone,
      salesChannelId: input.salesChannelId,
      baseline: input.baseline,
      expectFactor: input.expectFactor,
      holidays: input.holidays,
    });
  },
});
