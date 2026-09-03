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

function toIso(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`Invalid date: ${value}`);
  return parsed.toISOString();
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
}

export async function buildSalesReport(client: ShopwareClient, input: SalesReportInput) {
  const now = new Date();
  const from = toIso(input.from, new Date(now.getTime() - 30 * DAY_MS));
  const to = toIso(input.to, now);
  if (from > to) throw badRequest("`from` must be before `to`");

  const orderFilters: ShopwareFilter[] = [
    { type: "range", field: "orderDateTime", parameters: { gte: from, lte: to } },
  ];
  if (input.salesChannelId) orderFilters.push(equals("salesChannelId", input.salesChannelId));
  if (input.excludeCancelled) orderFilters.push(notCancelled());

  const lineItemFilters: ShopwareFilter[] = [
    equals("type", "product"),
    { type: "range", field: "order.orderDateTime", parameters: { gte: from, lte: to } },
  ];
  if (input.salesChannelId)
    lineItemFilters.push(equals("order.salesChannelId", input.salesChannelId));
  if (input.excludeCancelled) lineItemFilters.push(notCancelled("order."));

  const revenue = { name: "revenue", type: "sum", field: "amountTotal" };

  const [orders, lineItems] = await Promise.all([
    client.search<Raw>("order", {
      page: 1,
      limit: 1,
      "total-count-mode": 1,
      filter: orderFilters,
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
          name: "topByOrders",
          type: "terms",
          field: "productId",
          limit: input.topProducts,
          sort: { field: "_count", order: "DESC" },
          aggregation: { name: "quantity", type: "sum", field: "quantity" },
        },
        {
          name: "topRevenue",
          type: "terms",
          field: "productId",
          limit: input.topProducts,
          sort: { field: "_count", order: "DESC" },
          aggregation: { name: "revenue", type: "sum", field: "totalPrice" },
        },
      ],
    }),
  ]);

  const orderCount = orders.total;
  const totalRevenue = round2(sumOf(orders.aggregations.revenue));
  const revenueByKey = new Map(
    bucketsOf(lineItems.aggregations, "topRevenue").map((bucket) => [bucket.key, bucket.nested]),
  );
  const topBuckets = bucketsOf(lineItems.aggregations, "topByOrders").filter(
    (bucket) => bucket.key,
  );
  const productIds = topBuckets.map((bucket) => bucket.key as string);
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

  return {
    period: { from, to, interval: input.interval },
    filters: {
      salesChannelId: input.salesChannelId ?? null,
      excludeCancelled: input.excludeCancelled,
    },
    totals: {
      orders: orderCount,
      revenueGross: totalRevenue,
      revenueNet: round2(sumOf(orders.aggregations.net)),
      shipping: round2(sumOf(orders.aggregations.shipping)),
      averageOrderValue: orderCount > 0 ? round2(totalRevenue / orderCount) : 0,
      note: "Amounts are summed in each order's own currency; see revenueByCurrency for the split.",
    },
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
        ordersContaining: bucket.count,
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
    "Defaults to the last 30 days, cancelled orders excluded. Returns one object.",
  inputSchema: {
    from: isoDate.optional().describe("Start (inclusive), ISO date. Default: 30 days ago"),
    to: isoDate.optional().describe("End (inclusive), ISO date. Default: now"),
    interval: z.enum(["day", "week", "month"]).default("day").describe("Timeline bucket size"),
    salesChannelId: idSchema.optional().describe("Restrict to one sales channel"),
    excludeCancelled: z.boolean().default(true),
    topProducts: z.number().int().min(1).max(25).default(10),
  },
  handler: (input, ctx) => buildSalesReport(ctx.client, input),
});
