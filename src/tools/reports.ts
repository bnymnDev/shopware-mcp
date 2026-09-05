import { z } from "zod";
import { equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { bucketsOf, round2, sumOf } from "./aggregations.js";
import { idSchema, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

const DAY_MS = 86_400_000;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use an ISO date like 2026-08-01");

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A date without a time means the whole day: its start for `from`, its last millisecond for `to`.
 * A time without an offset is read as UTC, like a bare date, rather than as the server's zone.
 */
function toIso(value: string | undefined, fallback: Date, endOfDay = false): string {
  if (!value) return fallback.toISOString();
  const normalized = value.includes("T") && !HAS_OFFSET.test(value) ? `${value}Z` : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`Invalid date: ${value}`);
  if (endOfDay && DATE_ONLY.test(value)) parsed.setUTCHours(23, 59, 59, 999);
  return parsed.toISOString();
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

function change(current: number, previous: number) {
  return {
    absolute: round2(current - previous),
    percent: previous === 0 ? null : round2(((current - previous) / previous) * 100),
  };
}

function notCancelled(prefix = ""): ShopwareFilter {
  return {
    type: "not",
    operator: "and",
    queries: [equals(`${prefix}stateMachineState.technicalName`, "cancelled")],
  };
}

export interface SalesReportInput {
  from?: string;
  to?: string;
  interval: "day" | "week" | "month";
  salesChannelId?: string;
  excludeCancelled: boolean;
  topProducts: number;
  compareWithPrevious?: boolean;
}

export async function buildSalesReport(client: ShopwareClient, input: SalesReportInput) {
  const now = new Date();
  const from = toIso(input.from, new Date(now.getTime() - 30 * DAY_MS));
  const to = toIso(input.to, now, true);
  if (from > to) throw badRequest("`from` must be before `to`");

  // The period of equal length that ends right before `from`.
  const previousTo = new Date(Date.parse(from) - 1);
  const previousFrom = new Date(previousTo.getTime() - (Date.parse(to) - Date.parse(from)));

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
        {
          name: "timeline",
          type: "histogram",
          field: "orderDateTime",
          interval: input.interval,
          aggregation: revenue,
        },
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
      ? periodTotals(client, previousFrom.toISOString(), previousTo.toISOString(), input)
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

  return {
    period: { from, to, interval: input.interval },
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
    timeline: bucketsOf(orders.aggregations, "timeline").map((bucket) => ({
      bucket: bucket.key,
      orders: bucket.count,
      revenue: round2(sumOf(bucket.nested)),
    })),
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
  },
  handler: (input, ctx) => buildSalesReport(ctx.client, input),
});
