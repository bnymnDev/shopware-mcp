import { z } from "zod";
import { equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { bucketsOf, countOf, round2, sumOf } from "./aggregations.js";
import {
  dateRange,
  isoDate,
  notCancelled,
  type Period,
  previousPeriod,
  resolvePeriod,
} from "./periods.js";
import { idSchema, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

/** Shopware's delivery states for goods that came back, in full or in part. */
const RETURNED = ["returned", "returned_partially"];
/** Products ranked by returns are looked at among this many with the most returned orders. */
const PRODUCT_BUCKETS = 200;

export interface ReturnsInput {
  from?: string;
  to?: string;
  salesChannelId?: string;
  topProducts: number;
  minOrders: number;
}

const percent = (part: number, whole: number): number | null =>
  whole === 0 ? null : round2((part / whole) * 100);

function orderFilters(period: Period, input: ReturnsInput, prefix = ""): ShopwareFilter[] {
  return [
    dateRange(`${prefix}orderDateTime`, period),
    notCancelled(prefix),
    ...(input.salesChannelId ? [equals(`${prefix}salesChannelId`, input.salesChannelId)] : []),
  ];
}

const returnedFilter = (prefix = "") =>
  equalsAny(`${prefix}deliveries.stateMachineState.technicalName`, RETURNED);

async function orderFigures(client: ShopwareClient, period: Period, input: ReturnsInput) {
  const result = await client.search<Raw>("order", {
    page: 1,
    limit: 1,
    "total-count-mode": 1,
    filter: orderFilters(period, input),
    includes: { order: ["id"] },
    aggregations: [
      {
        name: "returned",
        type: "filter",
        filter: [returnedFilter()],
        aggregation: { name: "returnedCount", type: "count", field: "id" },
      },
      {
        name: "returnedRevenue",
        type: "filter",
        filter: [returnedFilter()],
        aggregation: { name: "returnedSum", type: "sum", field: "amountTotal" },
      },
      {
        name: "partial",
        type: "filter",
        filter: [equals("deliveries.stateMachineState.technicalName", "returned_partially")],
        aggregation: { name: "partialCount", type: "count", field: "id" },
      },
    ],
  });
  const returned = countOf(result.aggregations.returnedCount);
  const partial = countOf(result.aggregations.partialCount);
  return {
    orders: result.total,
    returnedOrders: returned,
    partially: partial,
    returnRate: percent(returned, result.total),
    returnedRevenue: round2(sumOf(result.aggregations.returnedSum)),
  };
}

/**
 * How many orders came back, and which products come back most. Shopware records returns per
 * delivery, not per item, so a product's rate is the share of its orders that came back in
 * full or in part: a product that is often in returned orders is worth a look, not proof.
 */
export async function buildReturnsReport(client: ShopwareClient, input: ReturnsInput) {
  const period = resolvePeriod(input, 90);
  const before = previousPeriod(period);
  const lineItems = (extra: ShopwareFilter[], limit: number) =>
    client.search<Raw>("order-line-item", {
      page: 1,
      limit: 1,
      "total-count-mode": 0,
      filter: [equals("type", "product"), ...orderFilters(period, input, "order."), ...extra],
      includes: { order_line_item: ["id"] },
      aggregations: [
        {
          name: "byProduct",
          type: "terms",
          field: "productId",
          limit,
          sort: { field: "_count", order: "DESC" },
        },
      ],
    });

  const [current, previous, returnedItems] = await Promise.all([
    orderFigures(client, period, input),
    orderFigures(client, before, input),
    lineItems([returnedFilter("order.")], PRODUCT_BUCKETS),
  ]);
  const returnedBy = new Map(
    bucketsOf(returnedItems.aggregations, "byProduct")
      .filter((bucket) => typeof bucket.key === "string")
      .map((bucket) => [bucket.key as string, bucket.count]),
  );
  const ids = [...returnedBy.keys()];
  const [allItems, products] =
    ids.length > 0
      ? await Promise.all([
          lineItems([equalsAny("productId", ids)], ids.length),
          client.search<Raw>(
            "product",
            {
              page: 1,
              limit: ids.length,
              filter: [equalsAny("id", ids)],
              includes: { product: ["id", "productNumber", "name", "translated"] },
            },
            { "sw-inheritance": "true" },
          ),
        ])
      : [null, null];
  const orderedBy = new Map(
    bucketsOf(allItems?.aggregations ?? {}, "byProduct").map((bucket) => [
      String(bucket.key),
      bucket.count,
    ]),
  );
  const productById = new Map((products?.items ?? []).map((product) => [str(product.id), product]));
  const ranked = ids
    .map((id) => {
      const orders = orderedBy.get(id) ?? 0;
      const returnedOrders = returnedBy.get(id) ?? 0;
      const product = productById.get(id) ?? null;
      return {
        productId: id,
        productNumber: str(product?.productNumber),
        name: translated(product, "name"),
        orders,
        returnedOrders,
        returnRate: percent(returnedOrders, orders),
      };
    })
    .filter((entry) => entry.orders >= input.minOrders)
    .sort(
      (a, b) => (b.returnRate ?? 0) - (a.returnRate ?? 0) || b.returnedOrders - a.returnedOrders,
    )
    .slice(0, input.topProducts);

  return {
    period: { ...period, previous: before },
    filters: { salesChannelId: input.salesChannelId ?? null, minOrders: input.minOrders },
    totals: current,
    previous,
    change: {
      returnRate:
        current.returnRate === null || previous.returnRate === null
          ? null
          : round2(current.returnRate - previous.returnRate),
    },
    products: ranked,
    note:
      "Shopware records returns per delivery, not per item: a product's rate is the share of its " +
      "orders that came back in full or in part. Cancelled orders are left out.",
  };
}

export const returnsReport = defineTool({
  name: "returns_report",
  title: "Returns report",
  description:
    "How many orders came back and which products come back most, from Shopware's own " +
    "delivery states (returned, returned partially), no plugin needed. Gives the return rate " +
    "of the period next to the period before, the revenue of returned orders, and products " +
    "ranked by the share of their orders that came back. Use it for 'what do customers send " +
    "back?' or before reordering stock. Read-only. Returns { period, totals, previous, change, " +
    "products[], note }.",
  inputSchema: {
    from: isoDate.optional().describe("Start (inclusive), ISO date. Default: 90 days ago"),
    to: isoDate.optional().describe("End (inclusive; a date covers the whole day). Default: now"),
    salesChannelId: idSchema.optional().describe("Restrict to one sales channel"),
    topProducts: z.number().int().min(1).max(50).default(10),
    minOrders: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(3)
      .describe("Rank only products with at least this many orders, so one return is no 100 %"),
  },
  handler: (input, ctx) => buildReturnsReport(ctx.client, input),
});
