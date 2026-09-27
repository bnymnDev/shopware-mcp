import { randomBytes } from "node:crypto";
import { z } from "zod";
import { STOREFRONT_TYPE_ID, UUID_PATTERN } from "../client/constants.js";
import { associations, equals, equalsAny } from "../client/criteria.js";
import type { HttpMethod, Raw, ShopwareClient } from "../client/index.js";
import { INHERITANCE_HEADERS } from "../client/index.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../logger.js";
import { bool, idSchema, num, raw, rawList, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

/** Product comparison feeds have no cart; every other sales channel type speaks the Store API. */
const COMPARISON_TYPE_ID = "ed535e5722134ac1aa6524f73e26881b";

/** Shopware's product visibility levels; search needs at least SEARCH. */
const VISIBILITY_LINK = 10;
const VISIBILITY_SEARCH = 20;

interface MethodInfo {
  id: string;
  name: string | null;
  technicalName: string | null;
  active: boolean;
  rule: string | null;
}

interface CountryInfo {
  id: string;
  iso: string | null;
  name: string | null;
}

export interface ChannelInfo {
  id: string;
  name: string | null;
  storefront: boolean;
  active: boolean;
  maintenance: boolean;
  languageId: string | null;
  currency: string | null;
  countries: CountryInfo[];
  paymentMethods: MethodInfo[];
  shippingMethods: MethodInfo[];
}

function mapMethod(method: Raw): MethodInfo | null {
  const id = str(method.id);
  if (!id) return null;
  return {
    id,
    name: translated(method, "name"),
    technicalName: str(method.technicalName),
    active: bool(method.active) ?? false,
    rule: str(raw(method.availabilityRule)?.name),
  };
}

function mapChannel(channel: Raw): ChannelInfo | null {
  const id = str(channel.id);
  if (!id) return null;
  return {
    id,
    name: translated(channel, "name"),
    storefront: channel.typeId === STOREFRONT_TYPE_ID,
    active: bool(channel.active) ?? false,
    maintenance: bool(channel.maintenance) ?? false,
    languageId: str(channel.languageId),
    currency: str(raw(channel.currency)?.isoCode),
    countries: [],
    paymentMethods: rawList(channel.paymentMethods)
      .map(mapMethod)
      .filter((method): method is MethodInfo => method !== null),
    shippingMethods: rawList(channel.shippingMethods)
      .map(mapMethod)
      .filter((method): method is MethodInfo => method !== null),
  };
}

/** Every sales channel that has a cart, with the countries and methods assigned to it. */
export async function loadChannels(client: ShopwareClient): Promise<ChannelInfo[]> {
  const result = await client.search<Raw>("sales-channel", {
    page: 1,
    limit: 50,
    sort: [{ field: "name", order: "ASC" }],
    associations: associations([
      "currency",
      "paymentMethods.availabilityRule",
      "shippingMethods.availabilityRule",
    ]),
    includes: {
      sales_channel: [
        "id",
        "name",
        "translated",
        "typeId",
        "active",
        "maintenance",
        "languageId",
        "currency",
        "paymentMethods",
        "shippingMethods",
      ],
      currency: ["isoCode"],
      payment_method: ["id", "name", "translated", "technicalName", "active", "availabilityRule"],
      shipping_method: ["id", "name", "translated", "technicalName", "active", "availabilityRule"],
      rule: ["name"],
    },
  });
  return result.items
    .filter((channel) => channel.typeId !== COMPARISON_TYPE_ID)
    .map(mapChannel)
    .filter((channel): channel is ChannelInfo => channel !== null);
}

/** The countries a channel ships to; loaded for the one channel in use, since a shop may list all. */
async function loadCountries(client: ShopwareClient, channelId: string): Promise<CountryInfo[]> {
  const result = await client.search<Raw>("country", {
    page: 1,
    limit: 300,
    filter: [equals("salesChannels.id", channelId)],
    sort: [{ field: "iso", order: "ASC" }],
    includes: { country: ["id", "iso", "name", "translated"] },
  });
  return result.items
    .map((country) => ({
      id: str(country.id) ?? "",
      iso: str(country.iso),
      name: translated(country, "name"),
    }))
    .filter((country) => country.id !== "");
}

/** A channel by id or name; without a reference the first active storefront, else any active one. */
export async function resolveChannel(client: ShopwareClient, ref?: string): Promise<ChannelInfo> {
  const channels = await loadChannels(client);
  if (ref) {
    const wanted = ref.trim().toLowerCase();
    const found = UUID_PATTERN.test(wanted)
      ? channels.find((channel) => channel.id === wanted)
      : channels.find((channel) => channel.name?.toLowerCase() === wanted);
    if (!found) {
      const names = channels.map((channel) => channel.name).filter(Boolean);
      throw badRequest(`No sales channel "${ref}" with a cart. Known: ${names.join(", ")}`);
    }
    return found;
  }
  const found =
    channels.find((channel) => channel.storefront && channel.active) ??
    channels.find((channel) => channel.active) ??
    channels[0];
  if (!found) throw notFound("sales_channel", "with a cart");
  return found;
}

/**
 * A throwaway Store API session through Shopware's admin proxy, the same route the admin's
 * "create order" dialog uses. The proxy supplies the channel's access key; the random context
 * token keeps this session apart from every real visitor.
 */
export class StoreSession {
  readonly token = randomBytes(16).toString("hex");

  constructor(
    private readonly client: ShopwareClient,
    readonly channelId: string,
  ) {}

  call<T>(
    path: string,
    options: { method?: HttpMethod; body?: unknown; idempotent?: boolean } = {},
  ): Promise<T> {
    return this.client.request<T>(`/api/_proxy/store-api/${this.channelId}/${path}`, {
      method: options.method ?? "GET",
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.idempotent !== undefined ? { idempotent: options.idempotent } : {}),
      headers: { "sw-context-token": this.token },
    });
  }

  /** Log this session in as a customer, which brings their group, prices, rules and address. */
  async switchCustomer(customerId: string): Promise<void> {
    await this.client.request("/api/_proxy/switch-customer", {
      method: "PATCH",
      body: { salesChannelId: this.channelId, customerId },
      headers: { "sw-context-token": this.token },
      idempotent: true,
    });
  }

  /** Drop the cart; a failure here is logged, never thrown over the simulation's answer. */
  async discardCart(): Promise<boolean> {
    try {
      await this.call("checkout/cart", { method: "DELETE", idempotent: true });
      return true;
    } catch (error) {
      logger.warn("could not delete the simulated cart", { error: String(error) });
      return false;
    }
  }
}

/* ------------------------------------------------------------------------------------------
 * Products, countries, customers, promotions: what the explanations are made of
 * ---------------------------------------------------------------------------------------- */

interface ProductInfo {
  id: string;
  productNumber: string | null;
  name: string | null;
  active: boolean | null;
  isCloseout: boolean | null;
  availableStock: number | null;
  minPurchase: number | null;
  maxPurchase: number | null;
  purchaseSteps: number | null;
  releaseDate: string | null;
  visibilities: { salesChannelId: string | null; visibility: number | null }[];
}

function mapProductInfo(product: Raw): ProductInfo {
  return {
    id: str(product.id) ?? "",
    productNumber: str(product.productNumber),
    name: translated(product, "name"),
    active: bool(product.active),
    isCloseout: bool(product.isCloseout),
    availableStock: num(product.availableStock),
    minPurchase: num(product.minPurchase),
    maxPurchase: num(product.maxPurchase),
    purchaseSteps: num(product.purchaseSteps),
    releaseDate: str(product.releaseDate),
    visibilities: rawList(product.visibilities).map((entry) => ({
      salesChannelId: str(entry.salesChannelId),
      visibility: num(entry.visibility),
    })),
  };
}

const PRODUCT_CRITERIA = {
  associations: associations(["visibilities"]),
  includes: {
    product: [
      "id",
      "productNumber",
      "name",
      "translated",
      "active",
      "isCloseout",
      "availableStock",
      "minPurchase",
      "maxPurchase",
      "purchaseSteps",
      "releaseDate",
      "visibilities",
    ],
    product_visibility: ["salesChannelId", "visibility"],
  },
};

async function loadProducts(
  client: ShopwareClient,
  refs: { productNumber?: string | undefined; productId?: string | undefined }[],
): Promise<ProductInfo[]> {
  const numbers = refs.map((ref) => ref.productNumber).filter((value): value is string => !!value);
  const ids = refs.map((ref) => ref.productId).filter((value): value is string => !!value);
  const filters = [
    ...(numbers.length > 0 ? [equalsAny("productNumber", numbers)] : []),
    ...(ids.length > 0 ? [equalsAny("id", ids)] : []),
  ];
  const result = await client.search<Raw>(
    "product",
    {
      page: 1,
      limit: Math.min(50, refs.length * 2),
      filter: filters.length > 1 ? [{ type: "multi", operator: "or", queries: filters }] : filters,
      ...PRODUCT_CRITERIA,
    },
    INHERITANCE_HEADERS,
  );
  return result.items.map(mapProductInfo);
}

/** Plain-language reasons a product cannot be bought or found in a channel; empty when none. */
function productReasons(product: ProductInfo, channel: ChannelInfo, now: Date, forSearch = false) {
  const reasons: string[] = [];
  if (product.active === false) reasons.push("the product is inactive");
  const visibility = product.visibilities.find((entry) => entry.salesChannelId === channel.id);
  if (!visibility) reasons.push(`it is not visible in ${channel.name ?? "this sales channel"}`);
  else if (forSearch && (visibility.visibility ?? 0) < VISIBILITY_SEARCH) {
    reasons.push(
      visibility.visibility === VISIBILITY_LINK
        ? "its visibility is 'hide in listings and search' (reachable by link only)"
        : "its visibility excludes search",
    );
  }
  if (product.isCloseout && (product.availableStock ?? 0) <= 0) {
    reasons.push("it is a closeout article with no available stock");
  }
  if (product.releaseDate && Date.parse(product.releaseDate) > now.getTime()) {
    reasons.push(`it is released on ${product.releaseDate.slice(0, 10)}`);
  }
  return reasons;
}

interface PromotionInfo {
  name: string | null;
  active: boolean | null;
  validFrom: string | null;
  validUntil: string | null;
  useCodes: boolean | null;
  maxRedemptionsGlobal: number | null;
  orderCount: number | null;
  salesChannelIds: string[];
  rules: string[];
}

const PROMOTION_CRITERIA = {
  associations: associations(["salesChannels", "personaRules", "cartRules", "orderRules"]),
  includes: {
    promotion: [
      "id",
      "name",
      "translated",
      "active",
      "validFrom",
      "validUntil",
      "useCodes",
      "maxRedemptionsGlobal",
      "orderCount",
      "salesChannels",
      "personaRules",
      "cartRules",
      "orderRules",
    ],
    promotion_sales_channel: ["salesChannelId"],
    rule: ["name"],
  },
};

function mapPromotion(promotion: Raw): PromotionInfo {
  const rules = [
    ...rawList(promotion.personaRules),
    ...rawList(promotion.cartRules),
    ...rawList(promotion.orderRules),
  ]
    .map((rule) => str(rule.name))
    .filter((name): name is string => name !== null);
  return {
    name: translated(promotion, "name"),
    active: bool(promotion.active),
    validFrom: str(promotion.validFrom),
    validUntil: str(promotion.validUntil),
    useCodes: bool(promotion.useCodes),
    maxRedemptionsGlobal: num(promotion.maxRedemptionsGlobal),
    orderCount: num(promotion.orderCount),
    salesChannelIds: rawList(promotion.salesChannels)
      .map((entry) => str(entry.salesChannelId))
      .filter((id): id is string => id !== null),
    rules: [...new Set(rules)],
  };
}

/** The promotion behind a code: a fixed code first, then an individual code. */
async function findPromotion(client: ShopwareClient, code: string) {
  const fixed = await client.search<Raw>("promotion", {
    page: 1,
    limit: 1,
    filter: [equals("code", code)],
    ...PROMOTION_CRITERIA,
  });
  const promotion = fixed.items[0];
  if (promotion) return mapPromotion(promotion);
  const individual = await client.search<Raw>("promotion-individual-code", {
    page: 1,
    limit: 1,
    filter: [equals("code", code)],
    associations: {
      promotion: {
        associations: associations(["salesChannels", "personaRules", "cartRules", "orderRules"]),
      },
    },
    includes: {
      promotion_individual_code: ["promotion", "payload"],
      ...PROMOTION_CRITERIA.includes,
    },
  });
  const entry = individual.items[0];
  const parent = raw(entry?.promotion);
  if (!entry || !parent) return null;
  const info = mapPromotion(parent);
  return { ...info, redeemed: raw(entry.payload) !== null };
}

function promotionReasons(
  promotion: PromotionInfo & { redeemed?: boolean },
  channel: ChannelInfo,
  now: Date,
): string[] {
  const reasons: string[] = [];
  if (promotion.active === false) reasons.push("it is inactive");
  if (promotion.validFrom && Date.parse(promotion.validFrom) > now.getTime()) {
    reasons.push(`it starts on ${promotion.validFrom.slice(0, 10)}`);
  }
  if (promotion.validUntil && Date.parse(promotion.validUntil) < now.getTime()) {
    reasons.push(`it ended on ${promotion.validUntil.slice(0, 10)}`);
  }
  if (promotion.salesChannelIds.length > 0 && !promotion.salesChannelIds.includes(channel.id)) {
    reasons.push(`it is not assigned to ${channel.name ?? "this sales channel"}`);
  }
  if (
    promotion.maxRedemptionsGlobal &&
    (promotion.orderCount ?? 0) >= promotion.maxRedemptionsGlobal
  ) {
    reasons.push(`it has reached its limit of ${promotion.maxRedemptionsGlobal} redemptions`);
  }
  if (promotion.redeemed) reasons.push("this individual code has already been redeemed");
  if (promotion.useCodes === false) reasons.push("it needs no code and applies automatically");
  return reasons;
}

/* ------------------------------------------------------------------------------------------
 * Cart errors, explained
 * ---------------------------------------------------------------------------------------- */

export interface CartProblem {
  key: string;
  level: "error" | "warning" | "notice";
  blocksOrder: boolean;
  message: string | null;
  explanation: string | null;
}

const LEVELS: Record<number, CartProblem["level"]> = { 20: "error", 10: "warning", 0: "notice" };

/** Shopware sends cart errors as an object keyed by error id, or `[]` when there are none. */
export function cartErrors(cart: Raw): Raw[] {
  const errors = cart.errors;
  if (Array.isArray(errors)) return rawList(errors);
  const byId = raw(errors);
  return byId
    ? Object.values(byId)
        .map(raw)
        .filter((entry): entry is Raw => entry !== null)
    : [];
}

interface ExplainContext {
  client: ShopwareClient;
  channel: ChannelInfo;
  country: { iso: string | null; name: string | null } | null;
  products: ProductInfo[];
  now: Date;
}

const list = (values: (string | null)[]) => values.filter(Boolean).join(", ") || "none";

async function explain(error: Raw, ctx: ExplainContext): Promise<string | null> {
  const key = str(error.messageKey) ?? str(error.key) ?? "";
  const params = raw(error.parameters) ?? {};
  const name = str(params.name);
  const byName = (value: string | null) =>
    ctx.products.find((product) => product.name === value) ?? null;
  switch (key) {
    case "shipping-address-blocked":
    case "billing-address-blocked": {
      const countries = ctx.channel.countries.map((country) => country.iso);
      const target = ctx.country?.name ?? name ?? "this country";
      const assigned = ctx.channel.countries.some((country) => country.name === target);
      return assigned
        ? `${target} is assigned to ${ctx.channel.name}, but shipping there is switched off for the country`
        : `${target} is not among the countries of ${ctx.channel.name} (${list(countries)})`;
    }
    case "promotion-not-found": {
      const code = str(params.code);
      if (!code) return null;
      const promotion = await findPromotion(ctx.client, code);
      if (!promotion) return `No promotion uses the code "${code}"`;
      const reasons = promotionReasons(promotion, ctx.channel, ctx.now);
      return reasons.length > 0
        ? `"${code}" belongs to "${promotion.name}", but ${reasons.join(", and ")}`
        : `"${code}" belongs to "${promotion.name}", which looks valid; Shopware still refused it`;
    }
    case "promotion-not-eligible":
    case "promotion-excluded": {
      if (!name) return null;
      const found = await ctx.client.search<Raw>("promotion", {
        page: 1,
        limit: 1,
        filter: [equals("name", name)],
        ...PROMOTION_CRITERIA,
      });
      const promotion = found.items[0] ? mapPromotion(found.items[0]) : null;
      if (!promotion) return null;
      return promotion.rules.length > 0
        ? `"${name}" only applies when these rules match: ${promotion.rules.join(", ")}`
        : `"${name}" is excluded by another promotion in the cart`;
    }
    case "product-not-found": {
      const id = str(params.id);
      const product = ctx.products.find((entry) => entry.id === id) ?? null;
      if (!product) return "The product does not exist";
      const reasons = productReasons(product, ctx.channel, ctx.now);
      return reasons.length > 0 ? `${product.productNumber}: ${reasons.join(", and ")}` : null;
    }
    case "product-out-of-stock": {
      const product = byName(name);
      return product
        ? `${product.productNumber} is a closeout article with ${product.availableStock ?? 0} available`
        : null;
    }
    case "product-stock-reached": {
      const product = byName(name);
      return product
        ? `Only ${product.availableStock ?? 0} of ${product.productNumber} are available; the cart lowered the quantity to ${num(params.quantity) ?? "that"}`
        : null;
    }
    case "min-order-quantity": {
      const product = byName(name);
      return product ? `${product.productNumber} sells from ${product.minPurchase} units` : null;
    }
    case "purchase-steps-quantity": {
      const product = byName(name);
      return product
        ? `${product.productNumber} sells in steps of ${product.purchaseSteps}; the cart rounded the quantity`
        : null;
    }
    case "shipping-method-blocked":
    case "payment-method-blocked": {
      const methods =
        key === "shipping-method-blocked"
          ? ctx.channel.shippingMethods
          : ctx.channel.paymentMethods;
      const method = methods.find((entry) => entry.name === name) ?? null;
      const reason = str(params.reason);
      if (method?.rule) return `${name} is only available when the rule "${method.rule}" matches`;
      return reason ? `${name}: ${reason}` : null;
    }
    default:
      return null;
  }
}

async function mapProblems(errors: Raw[], ctx: ExplainContext): Promise<CartProblem[]> {
  return Promise.all(
    errors.map(async (error) => ({
      key: str(error.messageKey) ?? str(error.key) ?? "unknown",
      level: LEVELS[num(error.level) ?? 0] ?? "notice",
      blocksOrder: bool(error.block) ?? false,
      message: str(error.translatedMessage) ?? str(error.message),
      explanation: await explain(error, ctx).catch(() => null),
    })),
  );
}

/** Methods assigned to the channel that this cart does not offer, with the likely reason. */
function hiddenMethods(assigned: MethodInfo[], availableIds: Set<string>) {
  return assigned
    .filter((method) => !availableIds.has(method.id))
    .map((method) => ({
      name: method.name,
      reason: !method.active
        ? "inactive"
        : method.rule
          ? `availability rule "${method.rule}" does not match`
          : "not available for this cart",
    }));
}

function findMethod(methods: MethodInfo[], wanted: string): MethodInfo | undefined {
  const needle = wanted.trim().toLowerCase();
  return methods.find(
    (method) =>
      method.name?.toLowerCase() === needle || method.technicalName?.toLowerCase() === needle,
  );
}

const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);

/** The tier a quantity falls into, from the Store API's calculated prices (upper bounds). */
function tierFor(tiers: Raw[], quantity: number) {
  const sorted = tiers
    .map((tier) => ({ upTo: num(tier.quantity), unitPrice: num(tier.unitPrice) }))
    .filter(
      (tier): tier is { upTo: number; unitPrice: number } =>
        tier.upTo !== null && tier.unitPrice !== null,
    )
    .sort((a, b) => a.upTo - b.upTo);
  return sorted.find((tier) => quantity <= tier.upTo) ?? sorted.at(-1) ?? null;
}

/* ------------------------------------------------------------------------------------------
 * checkout_simulate
 * ---------------------------------------------------------------------------------------- */

const itemSchema = z.object({
  productNumber: z.string().trim().min(1).optional().describe("Product number, e.g. SW10005"),
  productId: idSchema.optional().describe("Product UUID, instead of the number"),
  quantity: z.number().int().min(1).max(999).default(1),
});

export const checkoutSimulate = defineTool({
  name: "checkout_simulate",
  title: "Simulate a checkout",
  description:
    "See the checkout the way a customer does: puts products (and promotion codes) into a " +
    "throwaway cart of a sales channel through Shopware's own Store API, as a guest shipping " +
    "to a country or as a given customer with their group, prices and rules, and returns what " +
    "Shopware calculates: prices per item next to the listing price, discounts, shipping, " +
    "taxes, total, which payment and shipping methods the customer is offered, which are " +
    "hidden and by which rule, and every cart error with a plain explanation (country not " +
    "assigned, code expired, product not visible, stock). Nothing is ordered and the cart is " +
    "deleted afterwards. Use it for 'why can't this customer order?', 'why does this code not " +
    "work?' or 'what does shipping to Switzerland cost?'. Returns { salesChannel, as, " +
    "canOrder, items[], promotions[], shipping, totals, problems[], paymentMethods, " +
    "shippingMethods }.",
  annotations: { idempotentHint: false },
  inputSchema: {
    items: z.array(itemSchema).min(1).max(20).describe("Products and quantities for the cart"),
    promotionCodes: z
      .array(z.string().trim().min(1).max(255))
      .max(5)
      .optional()
      .describe("Promotion codes to redeem"),
    salesChannel: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Sales channel id or name; default: the first active storefront"),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "Use the two-letter ISO code, e.g. CH")
      .optional()
      .describe("Shipping country of a guest, as ISO code"),
    customerNumber: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Simulate as this customer: group, prices, rules and default addresses"),
    paymentMethod: z.string().trim().min(1).optional().describe("Payment method name to select"),
    shippingMethod: z.string().trim().min(1).optional().describe("Shipping method name to select"),
  },
  handler: async (input, ctx) => {
    const { client } = ctx;
    if (input.items.some((item) => !item.productNumber && !item.productId)) {
      throw badRequest("Every item needs a productNumber or a productId");
    }
    if (input.country && input.customerNumber) {
      throw badRequest("A customer ships to their own address; pass country only for a guest");
    }
    const now = new Date();
    const channel = await resolveChannel(client, input.salesChannel);
    const channelView = { id: channel.id, name: channel.name };

    if (!channel.active || channel.maintenance) {
      const reason = !channel.active ? "inactive" : "maintenance";
      return {
        salesChannel: channelView,
        as: null,
        canOrder: false,
        items: [],
        promotions: [],
        shipping: null,
        totals: null,
        problems: [
          {
            key: reason,
            level: "error" as const,
            blocksOrder: true,
            message:
              reason === "maintenance"
                ? "The sales channel is in maintenance mode."
                : "The sales channel is inactive.",
            explanation:
              reason === "maintenance"
                ? "Customers see the maintenance page and cannot order at all. Switch maintenance off in the sales channel, or allowlist an IP for testing."
                : "An inactive sales channel serves no customers.",
          },
        ],
        paymentMethods: null,
        shippingMethods: null,
        cartDeleted: false,
      };
    }

    const [products, country, customer, countries] = await Promise.all([
      loadProducts(client, input.items),
      input.country
        ? client.findOne<Raw>("country", "iso", input.country.toUpperCase(), {
            includes: { country: ["id", "iso", "name", "translated"] },
          })
        : Promise.resolve(null),
      input.customerNumber
        ? client.findOne<Raw>("customer", "customerNumber", input.customerNumber, {
            associations: associations(["group", "defaultShippingAddress.country"]),
            includes: {
              customer: [
                "id",
                "customerNumber",
                "firstName",
                "lastName",
                "active",
                "guest",
                "group",
                "defaultShippingAddress",
                "boundSalesChannelId",
              ],
              customer_group: ["name", "translated", "displayGross"],
              customer_address: ["country"],
              country: ["id", "iso", "name", "translated"],
            },
          })
        : Promise.resolve(null),
      loadCountries(client, channel.id),
    ]);
    channel.countries = countries;

    const lineItems = input.items.map((item) => {
      const product = products.find((entry) =>
        item.productId ? entry.id === item.productId : entry.productNumber === item.productNumber,
      );
      if (!product) throw notFound("product", item.productNumber ?? item.productId ?? "");
      return { product, quantity: item.quantity };
    });

    const problems: CartProblem[] = [];
    const contextPatch: Record<string, string> = {};
    if (country) contextPatch.countryId = String(country.id);
    for (const [field, wanted, methods] of [
      ["paymentMethodId", input.paymentMethod, channel.paymentMethods],
      ["shippingMethodId", input.shippingMethod, channel.shippingMethods],
    ] as const) {
      if (!wanted) continue;
      const method = findMethod(methods, wanted);
      if (method) contextPatch[field] = method.id;
      else {
        problems.push({
          key:
            field === "paymentMethodId"
              ? "payment-method-not-assigned"
              : "shipping-method-not-assigned",
          level: "warning",
          blocksOrder: false,
          message: `"${wanted}" is not assigned to ${channel.name}.`,
          explanation: `Assigned: ${list(methods.map((entry) => entry.name))}`,
        });
      }
    }

    const shipTo = country
      ? { iso: str(country.iso), name: translated(country, "name") }
      : customer
        ? (() => {
            const target = raw(raw(customer.defaultShippingAddress)?.country);
            return target ? { iso: str(target.iso), name: translated(target, "name") } : null;
          })()
        : null;

    const session = new StoreSession(client, channel.id);
    let discarded = false;
    try {
      if (customer) await session.switchCustomer(String(customer.id));
      if (Object.keys(contextPatch).length > 0) {
        await session.call("context", { method: "PATCH", body: contextPatch, idempotent: true });
      }
      const cart = await session.call<Raw>("checkout/cart/line-item", {
        method: "POST",
        idempotent: false,
        body: {
          items: [
            ...lineItems.map(({ product, quantity }) => ({
              id: product.id,
              type: "product",
              referencedId: product.id,
              quantity,
            })),
            ...(input.promotionCodes ?? []).map((code) => ({
              type: "promotion",
              referencedId: code,
            })),
          ],
        },
      });
      const productIds = lineItems.map(({ product }) => product.id);
      const [payments, shippings, listing] = await Promise.all([
        session.call<Raw>("payment-method", {
          method: "POST",
          idempotent: true,
          body: { onlyAvailable: true, includes: { payment_method: ["id", "name", "translated"] } },
        }),
        session.call<Raw>("shipping-method?onlyAvailable=1", {
          method: "POST",
          idempotent: true,
          body: { includes: { shipping_method: ["id", "name", "translated"] } },
        }),
        session.call<Raw>("product", {
          method: "POST",
          idempotent: true,
          body: {
            filter: [equalsAny("id", productIds)],
            limit: productIds.length,
            includes: {
              product: ["id", "calculatedPrice", "calculatedPrices"],
              calculated_price: ["unitPrice", "quantity"],
            },
          },
        }),
      ]);

      const explainCtx: ExplainContext = { client, channel, country: shipTo, products, now };
      problems.push(...(await mapProblems(cartErrors(cart), explainCtx)));

      const listed = new Map(
        rawList(listing.elements).map((element) => [str(element.id) ?? "", element]),
      );
      const cartLines = rawList(cart.lineItems);
      const items = lineItems.map(({ product, quantity }) => {
        const line = cartLines.find(
          (entry) => entry.type === "product" && entry.referencedId === product.id,
        );
        const price = raw(line?.price);
        const element = listed.get(product.id);
        const listingPrice = round(num(raw(element?.calculatedPrice)?.unitPrice));
        const unitPrice = round(num(price?.unitPrice));
        const tier = tierFor(rawList(element?.calculatedPrices), num(line?.quantity) ?? quantity);
        if (
          line &&
          listingPrice !== null &&
          unitPrice !== null &&
          Math.abs(listingPrice - unitPrice) > 0.01
        ) {
          problems.push({
            key: "price-differs-from-listing",
            level: "notice",
            blocksOrder: false,
            message: `${product.productNumber} is listed at ${listingPrice} but costs ${unitPrice} per unit in the cart.`,
            explanation:
              tier && Math.abs(tier.unitPrice - unitPrice) <= 0.01
                ? `A tier price applies up to ${tier.upTo} units; the listing shows the base price`
                : "A price rule applies in the cart that the listing does not show",
          });
        }
        return {
          productNumber: product.productNumber,
          name: str(line?.label) ?? product.name,
          requested: quantity,
          quantity: num(line?.quantity) ?? 0,
          unitPrice,
          totalPrice: round(num(price?.totalPrice)),
          listingPrice,
        };
      });

      const promotions = cartLines
        .filter((entry) => entry.type === "promotion")
        .map((entry) => ({
          code: str(raw(entry.payload)?.code) ?? str(entry.referencedId),
          label: str(entry.label),
          discount: round(num(raw(entry.price)?.totalPrice)),
        }));

      const delivery = rawList(cart.deliveries)[0];
      const cartPrice = raw(cart.price);
      const shippingCosts = round(num(raw(delivery?.shippingCosts)?.totalPrice));
      const availablePayments = rawList(payments.elements);
      const availableShippings = rawList(shippings.elements);
      if (availablePayments.length === 0) {
        problems.push({
          key: "no-payment-method",
          level: "error",
          blocksOrder: true,
          message: "No payment method is available for this cart.",
          explanation: "Every assigned payment method is inactive or excluded by its rule",
        });
      }
      if (availableShippings.length === 0) {
        problems.push({
          key: "no-shipping-method",
          level: "error",
          blocksOrder: true,
          message: "No shipping method is available for this cart.",
          explanation: "Every assigned shipping method is inactive or excluded by its rule",
        });
      }
      const group = raw(customer?.group);
      const selectedPayment = str(rawList(cart.transactions)[0]?.paymentMethodId);

      const result = {
        salesChannel: channelView,
        as: customer
          ? {
              customerNumber: str(customer.customerNumber),
              name: [str(customer.firstName), str(customer.lastName)].filter(Boolean).join(" "),
              group: translated(group, "name"),
              active: bool(customer.active),
              guest: bool(customer.guest),
              shipsTo: shipTo?.iso ?? null,
            }
          : { guest: true, shipsTo: shipTo?.iso ?? null },
        canOrder: !problems.some((problem) => problem.blocksOrder),
        currency: channel.currency,
        taxStatus: str(cartPrice?.taxStatus),
        items,
        promotions,
        shipping: delivery
          ? { method: translated(raw(delivery.shippingMethod), "name"), costs: shippingCosts }
          : null,
        totals: {
          positions: round(num(cartPrice?.positionPrice)),
          shipping: shippingCosts,
          net: round(num(cartPrice?.netPrice)),
          taxes: rawList(cartPrice?.calculatedTaxes).map((tax) => ({
            rate: num(tax.taxRate),
            amount: round(num(tax.tax)),
          })),
          total: round(num(cartPrice?.totalPrice)),
        },
        problems,
        paymentMethods: {
          selected:
            channel.paymentMethods.find((method) => method.id === selectedPayment)?.name ?? null,
          available: availablePayments.map((entry) => translated(entry, "name")),
          hidden: hiddenMethods(
            channel.paymentMethods,
            new Set(availablePayments.map((entry) => str(entry.id) ?? "")),
          ),
        },
        shippingMethods: {
          selected: delivery ? translated(raw(delivery.shippingMethod), "name") : null,
          available: availableShippings.map((entry) => translated(entry, "name")),
          hidden: hiddenMethods(
            channel.shippingMethods,
            new Set(availableShippings.map((entry) => str(entry.id) ?? "")),
          ),
        },
      };
      discarded = true;
      return { ...result, cartDeleted: await session.discardCart() };
    } finally {
      if (!discarded) await session.discardCart();
    }
  },
});

/* ------------------------------------------------------------------------------------------
 * storefront_search
 * ---------------------------------------------------------------------------------------- */

const SEARCH_INCLUDES = {
  product: [
    "id",
    "productNumber",
    "name",
    "translated",
    "calculatedPrice",
    "calculatedCheapestPrice",
    "available",
    "availableStock",
  ],
  calculated_price: ["unitPrice"],
  calculated_cheapest_price: ["unitPrice"],
};

const tokens = (term: string) =>
  [...new Set(term.toLowerCase().split(/[\s,;.]+/))].filter((token) => token.length >= 2);

export const storefrontSearch = defineTool({
  name: "storefront_search",
  title: "Search like a customer",
  description:
    "Run a search in a sales channel exactly as a customer would, through Shopware's Store " +
    "API: same visibility, stock and closeout rules, same ranking and prices. Optionally " +
    "explain one product: its position in the results, or why it does not show up (inactive, " +
    "not visible in the channel, link-only visibility, closeout without stock, not in the " +
    "search index, no search keyword matching the term). Read-only. Returns { salesChannel, " +
    "term, total, items[], explain? }.",
  inputSchema: {
    term: z.string().trim().min(1).max(100).describe("What the customer types"),
    salesChannel: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Sales channel id or name; default: the first active storefront"),
    limit: z.number().int().min(1).max(24).default(10).describe("Results to return"),
    explain: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Product number to explain: where it ranks, or why it is missing"),
  },
  handler: async (input, ctx) => {
    const { client } = ctx;
    const channel = await resolveChannel(client, input.salesChannel);
    const channelView = { id: channel.id, name: channel.name };
    if (!channel.active || channel.maintenance) {
      return {
        salesChannel: channelView,
        term: input.term,
        total: 0,
        items: [],
        note: channel.maintenance
          ? "The sales channel is in maintenance mode: customers see the maintenance page, not search results."
          : "The sales channel is inactive.",
      };
    }
    const session = new StoreSession(client, channel.id);
    const result = await session.call<Raw>("search", {
      method: "POST",
      idempotent: true,
      body: {
        search: input.term,
        p: 1,
        limit: input.explain ? 100 : input.limit,
        includes: SEARCH_INCLUDES,
      },
    });
    const elements = rawList(result.elements);
    const items = elements.slice(0, input.limit).map((element, index) => {
      const price = num(raw(element.calculatedPrice)?.unitPrice);
      const cheapest = num(raw(element.calculatedCheapestPrice)?.unitPrice);
      return {
        position: index + 1,
        productNumber: str(element.productNumber),
        name: translated(element, "name"),
        price: round(price),
        ...(cheapest !== null && price !== null && cheapest < price - 0.01
          ? { fromPrice: round(cheapest) }
          : {}),
        available: bool(element.available),
        stock: num(element.availableStock),
      };
    });
    const total = num(result.total) ?? elements.length;
    if (!input.explain) return { salesChannel: channelView, term: input.term, total, items };

    const wanted = input.explain;
    const position = elements.findIndex((element) => element.productNumber === wanted);
    const [product] = await loadProducts(client, [{ productNumber: wanted }]);
    if (!product) {
      return {
        salesChannel: channelView,
        term: input.term,
        total,
        items,
        explain: { productNumber: wanted, found: false, reasons: ["no product has this number"] },
      };
    }
    if (position >= 0) {
      return {
        salesChannel: channelView,
        term: input.term,
        total,
        items,
        explain: {
          productNumber: wanted,
          found: true,
          position: position + 1,
          page: Math.floor(position / 24) + 1,
          reasons: [],
        },
      };
    }
    const reasons = productReasons(product, channel, new Date(), true);
    const keywords = await client.search<Raw>("product-search-keyword", {
      page: 1,
      limit: 100,
      filter: [
        equals("productId", product.id),
        ...(channel.languageId ? [equals("languageId", channel.languageId)] : []),
      ],
      includes: { product_search_keyword: ["keyword"] },
    });
    const words = keywords.items
      .map((entry) => str(entry.keyword))
      .filter((word): word is string => !!word);
    if (words.length === 0) {
      reasons.push(
        "it has no search keywords: the search index has not been built for it (indexer or scheduled tasks not running)",
      );
    } else {
      const missing = tokens(input.term).filter(
        (token) => !words.some((word) => word.toLowerCase().includes(token)),
      );
      if (missing.length > 0) {
        reasons.push(
          `none of its search keywords contain ${missing.map((token) => `"${token}"`).join(", ")}; they include ${words.slice(0, 8).join(", ")}`,
        );
      }
    }
    if (reasons.length === 0 && elements.length >= 100) {
      reasons.push("it ranks below the first 100 results for this term");
    }
    return {
      salesChannel: channelView,
      term: input.term,
      total,
      items,
      explain: { productNumber: wanted, found: false, reasons },
    };
  },
});
