import { z } from "zod";
import { DEFAULT_CURRENCY_ID } from "../client/constants.js";
import { associations, equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import { INHERITANCE_HEADERS, type Raw, type ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { round2 } from "./aggregations.js";
import { DAY_MS, notCancelled } from "./periods.js";
import { idSchema, num, rawList, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

/** Pages read at most; beyond this the result says it is a sample. */
const MAX_ROWS = 5000;
const PAGE = 500;

async function readAll(
  client: ShopwareClient,
  entity: string,
  criteria: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ items: Raw[]; total: number }> {
  const items: Raw[] = [];
  let total = 0;
  for (let page = 1; items.length < MAX_ROWS; page++) {
    const result = await client.search<Raw>(
      entity,
      { ...criteria, page, limit: PAGE, "total-count-mode": page === 1 ? 1 : 0 },
      headers,
    );
    if (page === 1) total = result.total;
    items.push(...result.items);
    if (result.items.length < PAGE) break;
  }
  return { items, total: Math.max(total, items.length) };
}

/** The price in the default currency, as Shopware stores it: a list with one entry per currency. */
function defaultPrice(value: unknown): { net: number; gross: number } | null {
  const entries = rawList(value);
  const entry = entries.find((price) => price.currencyId === DEFAULT_CURRENCY_ID) ?? entries[0];
  const net = num(entry?.net);
  const gross = num(entry?.gross);
  return net === null || gross === null ? null : { net, gross };
}

interface Discount {
  type: "percentage" | "absolute";
  value: number;
  maxValue?: number | null;
}

/** What one discount takes from a cart of this value; Shopware never goes below zero. */
export function discountOn(positions: number, discount: Discount): number {
  if (positions <= 0) return 0;
  const raw = discount.type === "percentage" ? (positions * discount.value) / 100 : discount.value;
  const capped =
    discount.type === "percentage" && discount.maxValue ? Math.min(raw, discount.maxValue) : raw;
  return Math.min(capped, positions);
}

/* ------------------------------------------------------------------------------------------
 * promotion_impact: what a discount would have cost on the orders that really came in
 * ---------------------------------------------------------------------------------------- */

export interface ImpactInput {
  promotionId?: string | undefined;
  discount?: Discount | undefined;
  minCartValue?: number | undefined;
  days: number;
  salesChannelId?: string | undefined;
}

export async function promotionImpact(
  client: ShopwareClient,
  input: ImpactInput,
  now = new Date(),
) {
  let discounts: Discount[] = [];
  let channels: string[] = input.salesChannelId ? [input.salesChannelId] : [];
  let name: string | null = null;
  let automatic = false;
  const unmodelled: string[] = [];
  if (input.promotionId) {
    const promotion = await client.findById<Raw>("promotion", input.promotionId, {
      associations: associations(["discounts", "salesChannels", "personaRules", "cartRules"]),
    });
    name = translated(promotion, "name");
    automatic = promotion.useCodes === false;
    for (const discount of rawList(promotion.discounts)) {
      const type = str(discount.type);
      const scope = str(discount.scope);
      if (scope === "cart" && (type === "percentage" || type === "absolute")) {
        discounts.push({ type, value: num(discount.value) ?? 0, maxValue: num(discount.maxValue) });
      } else {
        unmodelled.push(`${type ?? "?"} discount on ${scope ?? "?"}`);
      }
    }
    if (!input.salesChannelId) {
      channels = rawList(promotion.salesChannels)
        .map((entry) => str(entry.salesChannelId))
        .filter((id): id is string => id !== null);
    }
    if (rawList(promotion.personaRules).length + rawList(promotion.cartRules).length > 0) {
      unmodelled.push("rules that limit who gets it");
    }
  } else if (input.discount) {
    discounts = [input.discount];
  } else {
    throw badRequest("Pass a promotionId or a discount to try");
  }

  const from = new Date(now.getTime() - input.days * DAY_MS);
  const filter: ShopwareFilter[] = [
    {
      type: "range",
      field: "orderDateTime",
      parameters: { gte: from.toISOString(), lte: now.toISOString() },
    },
    notCancelled(),
    ...(channels.length > 0 ? [equalsAny("salesChannelId", channels)] : []),
  ];
  const [orders, withCodes] = await Promise.all([
    readAll(client, "order", {
      filter,
      sort: [{ field: "orderDateTime", order: "DESC" }],
      includes: { order: ["id", "positionPrice", "amountTotal"] },
    }),
    client.search<Raw>("order", {
      page: 1,
      limit: 1,
      "total-count-mode": 1,
      filter: [...filter, equals("lineItems.type", "promotion")],
      includes: { order: ["id"] },
    }),
  ]);

  const minimum = input.minCartValue ?? 0;
  let revenue = 0;
  let eligibleOrders = 0;
  let cost = 0;
  let capped = 0;
  for (const order of orders.items) {
    const positions = num(order.positionPrice) ?? 0;
    revenue += num(order.amountTotal) ?? 0;
    if (positions < minimum) continue;
    eligibleOrders++;
    for (const discount of discounts) {
      const value = discountOn(positions, discount);
      if (discount.type === "percentage" && discount.maxValue && value === discount.maxValue)
        capped++;
      cost += value;
    }
  }
  const sample = orders.items.length < orders.total;
  const scale = sample && orders.items.length > 0 ? orders.total / orders.items.length : 1;
  const uptake = orders.total === 0 ? 0 : withCodes.total / orders.total;
  const share = (value: number) =>
    revenue === 0 ? null : round2((value / (revenue * scale)) * 100);
  const everyOrder = round2(cost * scale);
  return {
    promotion: input.promotionId ? { id: input.promotionId, name } : null,
    discounts,
    window: { from: from.toISOString(), to: now.toISOString(), days: input.days },
    orders: orders.total,
    revenue: round2(revenue * scale),
    eligibleOrders: Math.round(eligibleOrders * scale),
    scenarios: {
      everyEligibleOrder: { cost: everyOrder, shareOfRevenue: share(cost) },
      // How many orders carried any promotion so far: a fair guess for how many use a new code.
      ...(automatic
        ? {}
        : {
            usualCodeUptake: {
              share: round2(uptake * 100),
              cost: round2(everyOrder * uptake),
              shareOfRevenue: share(cost * uptake),
            },
          }),
    },
    averagePerOrder: eligibleOrders === 0 ? 0 : round2(cost / eligibleOrders),
    capReached: Math.round(capped * scale),
    ...(sample ? { sampled: `${orders.items.length} of ${orders.total} orders, scaled up` } : {}),
    note:
      "Replayed on the gross position total of each order. " +
      (automatic ? "It applies automatically, so every eligible order gets it. " : "") +
      (unmodelled.length > 0 ? `Not modelled: ${unmodelled.join(", ")}. ` : "") +
      "Rules that limit who gets the promotion are not evaluated, so this is the upper bound.",
  };
}

const discountSchema = z.object({
  type: z.enum(["percentage", "absolute"]),
  value: z.number().positive(),
  maxValue: z.number().positive().optional().describe("Cap for a percentage discount"),
});

export const promotionImpactTool = defineTool({
  name: "promotion_impact",
  title: "What would a discount cost?",
  description:
    "Before switching a promotion on: replay its cart discount (or one you describe) on the " +
    "orders of the last days and say what it would have cost: if every eligible order had used " +
    "it, and at the share of orders that used a promotion so far. Respects a percentage cap and " +
    "a minimum cart value; rules that limit who gets it are not evaluated, so the result is an " +
    "upper bound. Read-only. Returns { orders, revenue, eligibleOrders, scenarios, " +
    "averagePerOrder, capReached, note }.",
  inputSchema: {
    promotionId: idSchema.optional().describe("An existing promotion, e.g. from promotions_list"),
    discount: discountSchema.optional().describe("Or a discount to try: 'what if 20 % off?'"),
    minCartValue: z.number().min(0).optional().describe("Only carts from this value (gross)"),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe("Orders of how many days to replay"),
    salesChannelId: idSchema.optional().describe("Only this sales channel"),
  },
  handler: (input, ctx) => promotionImpact(ctx.client, input),
});

/* ------------------------------------------------------------------------------------------
 * margin_check: prices below cost, thin margins, and what active discounts leave
 * ---------------------------------------------------------------------------------------- */

export async function checkMargins(
  client: ShopwareClient,
  input: { minMargin: number; maxItems: number },
  now = new Date(),
) {
  const [products, promotions] = await Promise.all([
    readAll(
      client,
      "product",
      {
        filter: [
          equals("active", true),
          {
            type: "multi",
            operator: "or",
            queries: [equals("childCount", 0), equals("childCount", null)],
          },
        ],
        includes: {
          product: ["id", "productNumber", "name", "translated", "price", "purchasePrices"],
        },
      },
      INHERITANCE_HEADERS,
    ),
    client.search<Raw>("promotion", {
      page: 1,
      limit: 50,
      filter: [
        equals("active", true),
        equals("useCodes", false),
        {
          type: "multi",
          operator: "or",
          queries: [
            equals("validFrom", null),
            { type: "range", field: "validFrom", parameters: { lte: now.toISOString() } },
          ],
        },
        {
          type: "multi",
          operator: "or",
          queries: [
            equals("validUntil", null),
            { type: "range", field: "validUntil", parameters: { gte: now.toISOString() } },
          ],
        },
      ],
      associations: associations(["discounts"]),
      includes: {
        promotion: ["id", "name", "translated", "discounts", "exclusive"],
        promotion_discount: ["type", "value", "scope"],
      },
    }),
  ]);

  // The deepest automatic percentage on the cart that applies to everyone right now.
  let deepest: { name: string | null; percent: number } | null = null;
  for (const promotion of promotions.items) {
    for (const discount of rawList(promotion.discounts)) {
      const value = num(discount.value) ?? 0;
      if (
        str(discount.type) === "percentage" &&
        str(discount.scope) === "cart" &&
        value > (deepest?.percent ?? 0)
      ) {
        deepest = { name: translated(promotion, "name"), percent: value };
      }
    }
  }

  let unknown = 0;
  const rows: {
    productNumber: string | null;
    name: string | null;
    net: number;
    purchaseNet: number;
    margin: number;
    marginAfterDiscount: number | null;
  }[] = [];
  for (const product of products.items) {
    const price = defaultPrice(product.price);
    const purchase = defaultPrice(product.purchasePrices);
    if (!price || !purchase || purchase.net <= 0) {
      unknown++;
      continue;
    }
    const margin = price.net === 0 ? -100 : ((price.net - purchase.net) / price.net) * 100;
    const afterNet = deepest ? price.net * (1 - deepest.percent / 100) : null;
    const after =
      afterNet === null
        ? null
        : afterNet === 0
          ? -100
          : ((afterNet - purchase.net) / afterNet) * 100;
    rows.push({
      productNumber: str(product.productNumber),
      name: translated(product, "name"),
      net: round2(price.net),
      purchaseNet: round2(purchase.net),
      margin: round2(margin),
      marginAfterDiscount: after === null ? null : round2(after),
    });
  }
  const byMargin = (a: { margin: number }, b: { margin: number }) => a.margin - b.margin;
  const belowCost = rows.filter((row) => row.margin < 0).sort(byMargin);
  const thin = rows.filter((row) => row.margin >= 0 && row.margin < input.minMargin).sort(byMargin);
  const lossWithDiscount = rows
    .filter(
      (row) => row.margin >= 0 && row.marginAfterDiscount !== null && row.marginAfterDiscount < 0,
    )
    .sort(byMargin);
  return {
    checked: products.items.length,
    ...(products.items.length < products.total
      ? { sampled: `${products.items.length} of ${products.total} products` }
      : {}),
    withoutPurchasePrice: unknown,
    minMargin: input.minMargin,
    automaticDiscount: deepest,
    summary: {
      belowCost: belowCost.length,
      thin: thin.length,
      lossWithDiscount: lossWithDiscount.length,
    },
    belowCost: belowCost.slice(0, input.maxItems),
    thin: thin.slice(0, input.maxItems),
    lossWithDiscount: lossWithDiscount.slice(0, input.maxItems),
    note: "Net prices in the default currency against the net purchase price; variants inherit from their parent.",
  };
}

export const marginCheck = defineTool({
  name: "margin_check",
  title: "Margins: below cost and thin",
  description:
    "Find active products whose net price is below their purchase price, products with a thin " +
    "margin, and products that an automatic discount running right now pushes below cost: the " +
    "'60 % instead of 6 %' mistake on the price side. Uses Shopware's purchase price; products " +
    "without one are counted, not guessed. Read-only. Returns { checked, withoutPurchasePrice, " +
    "automaticDiscount, summary, belowCost[], thin[], lossWithDiscount[] }.",
  inputSchema: {
    minMargin: z
      .number()
      .min(0)
      .max(100)
      .default(15)
      .describe("Margin in % below which a product counts as thin"),
    maxItems: z.number().int().min(1).max(100).default(20),
  },
  handler: (input, ctx) => checkMargins(ctx.client, input),
});
