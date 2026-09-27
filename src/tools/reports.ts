import { z } from "zod";
import { equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { bucketsOf, round2, sumOf } from "./aggregations.js";
import {
  change,
  isoDate,
  notCancelled,
  previousPeriod as periodBefore,
  resolvePeriod,
} from "./periods.js";
import { idSchema, num, raw, str, translated } from "./shared.js";
import { defineTool } from "./types.js";
import { isTimeZone, localDate, midnightOf, shiftDays } from "./zone.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Local days are counted one filter per day; beyond this the timeline uses Shopware's UTC days. */
const MAX_LOCAL_DAYS = 92;

/**
 * The period with date-only bounds read as local days in `timeZone`: `from` at its local
 * midnight, `to` at the last millisecond of its local day.
 */
function resolveLocalPeriod(
  input: { from?: string; to?: string },
  timeZone: string,
  now: Date,
): { from: string; to: string } {
  const fallback = resolvePeriod(input, 30, now);
  const from =
    input.from && DATE_ONLY.test(input.from)
      ? midnightOf(input.from, timeZone).toISOString()
      : fallback.from;
  const to =
    input.to && DATE_ONLY.test(input.to)
      ? new Date(shiftDays(midnightOf(input.to, timeZone), 1, timeZone).getTime() - 1).toISOString()
      : fallback.to;
  if (from > to) throw badRequest("`from` must be before `to`");
  return { from, to };
}

/** One filter aggregation pair (orders, revenue) per local day of the period. */
function localDays(from: string, to: string, timeZone: string) {
  const days: { date: string; from: string; to: string }[] = [];
  let date = localDate(new Date(from), timeZone);
  const last = localDate(new Date(to), timeZone);
  while (date <= last && days.length <= MAX_LOCAL_DAYS) {
    const start = midnightOf(date, timeZone);
    const next = shiftDays(start, 1, timeZone);
    days.push({
      date,
      from: new Date(Math.max(start.getTime(), Date.parse(from))).toISOString(),
      to: new Date(Math.min(next.getTime() - 1, Date.parse(to))).toISOString(),
    });
    date = localDate(next, timeZone);
  }
  return days.length > MAX_LOCAL_DAYS ? null : days;
}

function orderFilters(from: string, to: string, input: SalesReportInput): ShopwareFilter[] {
  const filters: ShopwareFilter[] = [
    { type: "range", field: "orderDateTime", parameters: { gte: from, lte: to } },
  ];
  if (input.salesChannelId) filters.push(equals("salesChannelId", input.salesChannelId));
  if (input.excludeCancelled) filters.push(notCancelled());
  return filters;
}

interface PeriodTotals {
  from: string;
  to: string;
  orders: number;
  revenueGross: number;
  revenueNet: number;
  averageOrderValue: number;
}

/** Order count and revenue for one period, computed by Shopware. */
async function periodTotals(
  client: ShopwareClient,
  from: string,
  to: string,
  input: SalesReportInput,
): Promise<PeriodTotals> {
  const result = await client.search<Raw>("order", {
    page: 1,
    limit: 1,
    "total-count-mode": 1,
    filter: orderFilters(from, to, input),
    includes: { order: ["id"] },
    aggregations: [
      { name: "revenue", type: "sum", field: "amountTotal" },
      { name: "net", type: "sum", field: "amountNet" },
    ],
  });
  const revenueGross = round2(sumOf(result.aggregations.revenue));
  return {
    from,
    to,
    orders: result.total,
    revenueGross,
    revenueNet: round2(sumOf(result.aggregations.net)),
    averageOrderValue: result.total > 0 ? round2(revenueGross / result.total) : 0,
  };
}

export interface SalesReportInput {
  from?: string;
  to?: string;
  interval: "day" | "week" | "month";
  /** Read date-only bounds and daily buckets in this IANA time zone instead of UTC. */
  timeZone?: string | undefined;
  salesChannelId?: string;
  excludeCancelled: boolean;
  topProducts: number;
  compareWithPrevious?: boolean;
}

export async function buildSalesReport(client: ShopwareClient, input: SalesReportInput) {
  const now = new Date();
  const timeZone = input.timeZone;
  if (timeZone && !isTimeZone(timeZone)) throw badRequest(`Unknown time zone "${timeZone}"`);
  const { from, to } = timeZone
    ? resolveLocalPeriod(input, timeZone, now)
    : resolvePeriod(input, 30, now);
  const previous = periodBefore({ from, to });
  const days = timeZone && input.interval === "day" ? localDays(from, to, timeZone) : null;
  const timelineAggregations = days
    ? days.flatMap((day, index) => {
        const range = {
          type: "range",
          field: "orderDateTime",
          parameters: { gte: day.from, lte: day.to },
        };
        return [
          {
            name: `d${index}`,
            type: "filter",
            filter: [range],
            aggregation: { name: `d${index}n`, type: "count", field: "id" },
          },
          {
            name: `d${index}r`,
            type: "filter",
            filter: [range],
            aggregation: { name: `d${index}s`, type: "sum", field: "amountTotal" },
          },
        ];
      })
    : [
        {
          name: "timeline",
          type: "histogram",
          field: "orderDateTime",
          interval: input.interval,
          aggregation: { name: "revenue", type: "sum", field: "amountTotal" },
        },
      ];

  const lineItemFilters: ShopwareFilter[] = [
    equals("type", "product"),
    { type: "range", field: "order.orderDateTime", parameters: { gte: from, lte: to } },
  ];
  if (input.salesChannelId)
    lineItemFilters.push(equals("order.salesChannelId", input.salesChannelId));
  if (input.excludeCancelled) lineItemFilters.push(notCancelled("order."));

  const revenue = { name: "revenue", type: "sum", field: "amountTotal" };

  // All three run together so a failure in any of them is caught here, never left dangling.
  const [orders, lineItems, previousPeriod] = await Promise.all([
    client.search<Raw>("order", {
      page: 1,
      limit: 1,
      "total-count-mode": 1,
      filter: orderFilters(from, to, input),
      includes: { order: ["id"] },
      aggregations: [
        revenue,
        { name: "net", type: "sum", field: "amountNet" },
        { name: "shipping", type: "sum", field: "shippingTotal" },
        { name: "byState", type: "terms", field: "stateMachineState.technicalName" },
        { name: "byPayment", type: "terms", field: "transactions.stateMachineState.technicalName" },
        { name: "byDelivery", type: "terms", field: "deliveries.stateMachineState.technicalName" },
        { name: "byCurrency", type: "terms", field: "currency.isoCode", aggregation: revenue },
        { name: "bySalesChannel", type: "terms", field: "salesChannel.name", aggregation: revenue },
        { name: "byPaymentMethod", type: "terms", field: "transactions.paymentMethod.name" },
        ...timelineAggregations,
      ],
    }),
    client.search<Raw>("order-line-item", {
      page: 1,
      limit: 1,
      "total-count-mode": 0,
      filter: lineItemFilters,
      includes: { order_line_item: ["id"] },
      aggregations: [
        {
          name: "topProducts",
          type: "terms",
          field: "productId",
          limit: input.topProducts,
          sort: { field: "_count", order: "DESC" },
          aggregation: { name: "quantity", type: "sum", field: "quantity" },
        },
      ],
    }),
    input.compareWithPrevious
      ? periodTotals(client, previous.from, previous.to, input)
      : Promise.resolve(null),
  ]);

  const orderCount = orders.total;
  const totalRevenue = round2(sumOf(orders.aggregations.revenue));
  const topBuckets = bucketsOf(lineItems.aggregations, "topProducts").filter(
    (bucket) => bucket.key,
  );
  const productIds = topBuckets.map((bucket) => bucket.key as string);
  // Revenue is resolved for exactly these ids, so a tie in the top-N list cannot drop a value.
  const revenueByKey = new Map<string | null, unknown>();
  if (productIds.length > 0) {
    const revenueResult = await client.search<Raw>("order-line-item", {
      page: 1,
      limit: 1,
      "total-count-mode": 0,
      filter: [...lineItemFilters, equalsAny("productId", productIds)],
      includes: { order_line_item: ["id"] },
      aggregations: [
        {
          name: "revenue",
          type: "terms",
          field: "productId",
          limit: productIds.length,
          aggregation: { name: "revenue", type: "sum", field: "totalPrice" },
        },
      ],
    });
    for (const bucket of bucketsOf(revenueResult.aggregations, "revenue")) {
      revenueByKey.set(bucket.key, bucket.nested);
    }
  }

  const products =
    productIds.length > 0
      ? await client.search<Raw>(
          "product",
          {
            page: 1,
            limit: Math.min(productIds.length, 50),
            filter: [equalsAny("id", productIds)],
            includes: { product: ["id", "productNumber", "name", "translated"] },
          },
          { "sw-inheritance": "true" },
        )
      : null;
  const productById = new Map((products?.items ?? []).map((product) => [str(product.id), product]));

  const termsTable = (name: string) =>
    bucketsOf(orders.aggregations, name).map((bucket) => ({
      key: bucket.key,
      orders: bucket.count,
    }));

  const revenueNet = round2(sumOf(orders.aggregations.net));
  const averageOrderValue = orderCount > 0 ? round2(totalRevenue / orderCount) : 0;
  const comparison = previousPeriod
    ? {
        previousPeriod,
        change: {
          orders: change(orderCount, previousPeriod.orders),
          revenueGross: change(totalRevenue, previousPeriod.revenueGross),
          revenueNet: change(revenueNet, previousPeriod.revenueNet),
          averageOrderValue: change(averageOrderValue, previousPeriod.averageOrderValue),
        },
      }
    : {};

  const aggs = orders.aggregations;
  const timeline = days
    ? days.map((day, index) => ({
        bucket: `${day.date} 00:00:00`,
        orders: num(raw(aggs[`d${index}n`])?.count) ?? 0,
        revenue: round2(num(raw(aggs[`d${index}s`])?.sum) ?? 0),
      }))
    : bucketsOf(aggs, "timeline").map((bucket) => ({
        bucket: bucket.key,
        orders: bucket.count,
        revenue: round2(sumOf(bucket.nested)),
      }));

  return {
    period: {
      from,
      to,
      interval: input.interval,
      // Days are local to this zone; without one they are UTC days.
      timeZone: days ? (timeZone ?? null) : null,
      // The period includes this moment, so its last bucket is still filling.
      running: Date.parse(to) >= now.getTime(),
    },
    filters: {
      salesChannelId: input.salesChannelId ?? null,
      excludeCancelled: input.excludeCancelled,
    },
    totals: {
      orders: orderCount,
      revenueGross: totalRevenue,
      revenueNet,
      shipping: round2(sumOf(orders.aggregations.shipping)),
      averageOrderValue,
      note: "Amounts are summed in each order's own currency; see revenueByCurrency for the split.",
    },
    ...comparison,
    revenueByCurrency: bucketsOf(orders.aggregations, "byCurrency").map((bucket) => ({
      currency: bucket.key,
      orders: bucket.count,
      revenue: round2(sumOf(bucket.nested)),
    })),
    revenueBySalesChannel: bucketsOf(orders.aggregations, "bySalesChannel").map((bucket) => ({
      salesChannel: bucket.key,
      orders: bucket.count,
      revenue: round2(sumOf(bucket.nested)),
    })),
    ordersByState: termsTable("byState"),
    ordersByPaymentState: termsTable("byPayment"),
    ordersByDeliveryState: termsTable("byDelivery"),
    ordersByPaymentMethod: termsTable("byPaymentMethod"),
    timeline,
    topProducts: topBuckets.map((bucket) => {
      const product = productById.get(bucket.key);
      return {
        productId: bucket.key,
        productNumber: str(product?.productNumber),
        name: translated(product ?? null, "name"),
        lineItemCount: bucket.count,
        quantity: sumOf(bucket.nested),
        revenue: round2(sumOf(revenueByKey.get(bucket.key))),
      };
    }),
  };
}

export const salesReport = defineTool({
  name: "sales_report",
  title: "Sales report",
  description:
    "Aggregate sales figures for a period straight from Shopware: order count, gross/net revenue, " +
    "average order value, breakdowns by order/payment/delivery state, payment method, currency " +
    "and sales channel, a revenue timeline (day/week/month) and the top-selling products. " +
    "Use it for 'how did we do last month?' questions instead of paging through orders. " +
    "compareWithPrevious adds the period of equal length before `from` and the change in orders " +
    "and revenue. Defaults to the last 30 days, cancelled orders excluded. Returns one object.",
  inputSchema: {
    from: isoDate.optional().describe("Start (inclusive), ISO date. Default: 30 days ago"),
    to: isoDate
      .optional()
      .describe(
        "End (inclusive; a date without time covers the whole day), ISO date. Default: now",
      ),
    interval: z.enum(["day", "week", "month"]).default("day").describe("Timeline bucket size"),
    salesChannelId: idSchema.optional().describe("Restrict to one sales channel"),
    excludeCancelled: z.boolean().default(true),
    topProducts: z.number().int().min(1).max(25).default(10),
    compareWithPrevious: z
      .boolean()
      .default(false)
      .describe("Also report the preceding period of equal length and the change"),
    timeZone: z
      .string()
      .trim()
      .optional()
      .describe(
        "IANA time zone, e.g. Europe/Berlin: date-only from/to and daily buckets become local days. Default: UTC",
      ),
  },
  handler: (input, ctx) => buildSalesReport(ctx.client, input),
});
