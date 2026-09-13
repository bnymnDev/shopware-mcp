import { z } from "zod";
import { equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import { INHERITANCE_HEADERS, type Raw, type ShopwareClient } from "../client/index.js";
import { bucketsOf, round2, sumOf } from "./aggregations.js";
import { DAY_MS, notCancelled } from "./periods.js";
import { idSchema, num, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

/** Products with sales in the window that are considered; beyond it the fastest sellers win. */
const MAX_CANDIDATES = 1000;
/** Product pages of 50 read for the candidates; enough for any realistic reorder list. */
const MAX_PRODUCT_PAGES = 10;

export interface ForecastInput {
  days: number;
  horizon: number;
  restockDays: number;
  salesChannelId?: string;
  limit: number;
}

export interface ForecastItem {
  productId: string;
  productNumber: string | null;
  name: string | null;
  stock: number | null;
  availableStock: number | null;
  soldInWindow: number;
  perDay: number;
  daysOfCover: number;
  runsOutOn: string;
  suggestedReorder: number;
}

/**
 * Sales velocity per product over the window, from Shopware's own line item aggregation, joined
 * with the current available stock. A product is "running out" when its cover in days is below
 * the horizon; products without sales in the window never are.
 */
export async function buildStockForecast(
  client: ShopwareClient,
  input: ForecastInput,
  now = new Date(),
) {
  const from = new Date(now.getTime() - input.days * DAY_MS).toISOString();
  const filters: ShopwareFilter[] = [
    equals("type", "product"),
    { type: "range", field: "order.orderDateTime", parameters: { gte: from } },
    notCancelled("order."),
  ];
  if (input.salesChannelId) filters.push(equals("order.salesChannelId", input.salesChannelId));

  const sales = await client.search<Raw>("order-line-item", {
    page: 1,
    limit: 1,
    "total-count-mode": 0,
    filter: filters,
    includes: { order_line_item: ["id"] },
    aggregations: [
      {
        name: "byProduct",
        type: "terms",
        field: "productId",
        limit: MAX_CANDIDATES,
        sort: { field: "_count", order: "DESC" },
        aggregation: { name: "quantity", type: "sum", field: "quantity" },
      },
    ],
  });
  const velocity = new Map<string, { sold: number; perDay: number }>();
  for (const bucket of bucketsOf(sales.aggregations, "byProduct")) {
    if (!bucket.key) continue;
    const sold = sumOf(bucket.nested);
    if (sold > 0) velocity.set(bucket.key, { sold, perDay: sold / input.days });
  }
  const notes: string[] = [];
  if (velocity.size >= MAX_CANDIDATES) {
    notes.push(`Only the ${MAX_CANDIDATES} products with the most order lines were considered`);
  }

  const window = { from, to: now.toISOString(), days: input.days };
  if (velocity.size === 0) {
    return { window, horizon: input.horizon, restockDays: input.restockDays, total: 0, items: [] };
  }

  // Nothing with more stock than the fastest seller needs within the horizon can be flagged,
  // so that bound keeps the product lookup small on large catalogues.
  const maxDemand = Math.ceil(
    Math.max(...[...velocity.values()].map((v) => v.perDay)) * input.horizon,
  );
  const ids = [...velocity.keys()];
  const products: Raw[] = [];
  for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
    const result = await client.search<Raw>(
      "product",
      {
        page,
        limit: 50,
        filter: [
          equalsAny("id", ids),
          equals("active", true),
          { type: "range", field: "availableStock", parameters: { lt: maxDemand } },
        ],
        sort: [{ field: "availableStock", order: "ASC" }],
        includes: {
          product: ["id", "productNumber", "name", "translated", "stock", "availableStock"],
        },
      },
      INHERITANCE_HEADERS,
    );
    products.push(...result.items);
    if (result.items.length < 50) break;
    if (page === MAX_PRODUCT_PAGES) {
      notes.push(`Product lookup capped at ${MAX_PRODUCT_PAGES * 50}; the list may be incomplete`);
    }
  }

  const items: ForecastItem[] = [];
  for (const product of products) {
    const id = str(product.id);
    const rate = id ? velocity.get(id) : undefined;
    if (!id || !rate) continue;
    const available = num(product.availableStock) ?? num(product.stock) ?? 0;
    const daysOfCover = Math.max(0, available) / rate.perDay;
    if (daysOfCover >= input.horizon) continue;
    items.push({
      productId: id,
      productNumber: str(product.productNumber),
      name: translated(product, "name"),
      stock: num(product.stock),
      availableStock: num(product.availableStock),
      soldInWindow: rate.sold,
      perDay: round2(rate.perDay),
      daysOfCover: round2(daysOfCover),
      runsOutOn: new Date(now.getTime() + daysOfCover * DAY_MS).toISOString().slice(0, 10),
      // Enough to stay in stock through the horizon and `restockDays` beyond it; a negative
      // available stock is a backlog and is covered too.
      suggestedReorder: Math.max(
        0,
        Math.ceil(rate.perDay * (input.horizon + input.restockDays) - available),
      ),
    });
  }
  items.sort((a, b) => a.daysOfCover - b.daysOfCover || b.perDay - a.perDay);

  return {
    window,
    horizon: input.horizon,
    restockDays: input.restockDays,
    total: items.length,
    items: items.slice(0, input.limit),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

export const stockForecast = defineTool({
  name: "stock_forecast",
  title: "Stock forecast",
  description:
    "Which products run out soon, from real sales: units sold per product in the last `days` " +
    "(cancelled orders excluded), the current available stock, the days of cover at that pace, " +
    "the date the stock reaches zero and a reorder quantity that keeps it in stock through the " +
    "horizon plus `restockDays` more days (a negative stock is a backlog and is covered too). Lists " +
    "the active products whose cover is below `horizon` days, soonest first. Products without " +
    "sales in the window are never listed. Use it for 'what do I need to reorder?'. " +
    "Returns { window, horizon, restockDays, total, items[], notes? }.",
  inputSchema: {
    days: z.number().int().min(1).max(365).default(30).describe("Sales window in days"),
    horizon: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(14)
      .describe("List products that run out within this many days"),
    restockDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe("Days beyond the horizon the suggested reorder quantity should cover"),
    salesChannelId: idSchema.optional().describe("Count sales of one sales channel only"),
    limit: z.number().int().min(1).max(50).default(20),
  },
  handler: (input, ctx) => buildStockForecast(ctx.client, input),
});
