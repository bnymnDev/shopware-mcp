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
  active?: boolean | null;
  shippingAvailable?: boolean | null;
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
  return pickChannel(await loadChannels(client), ref);
}

function pickChannel(channels: ChannelInfo[], ref?: string): ChannelInfo {
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
    /** The channel's own language: the API language may not be assigned to the channel at all. */
    private readonly languageId: string | null = null,
  ) {}

  private get headers(): Record<string, string> {
    return {
      "sw-context-token": this.token,
      ...(this.languageId ? { "sw-language-id": this.languageId } : {}),
    };
  }

  call<T>(
    path: string,
    options: { method?: HttpMethod; body?: unknown; idempotent?: boolean } = {},
  ): Promise<T> {
    return this.client.request<T>(`/api/_proxy/store-api/${this.channelId}/${path}`, {
      method: options.method ?? "GET",
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.idempotent !== undefined ? { idempotent: options.idempotent } : {}),
      headers: this.headers,
    });
  }

  /** Log this session in as a customer, which brings their group, prices, rules and address. */
  async switchCustomer(customerId: string): Promise<void> {
    await this.client.request("/api/_proxy/switch-customer", {
      method: "PATCH",
      body: { salesChannelId: this.channelId, customerId },
      headers: this.headers,
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
  parentId: string | null;
  childCount: number | null;
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
    parentId: str(product.parentId),
    childCount: num(product.childCount),
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
      "parentId",
      "childCount",
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
  if (forSearch && product.isCloseout && (product.availableStock ?? 0) <= 0) {
    reasons.push(
      "it is a closeout article without stock, which search hides while the listing setting 'Hide products after clearance sale' is on",
    );
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
  useIndividualCodes: boolean | null;
  maxRedemptionsGlobal: number | null;
  orderCount: number | null;
  maxRedemptionsPerCustomer: number | null;
  ordersPerCustomerCount: Record<string, number>;
  salesChannelIds: string[];
  /** Discounts configured; null when they were not loaded. */
  discounts: number | null;
  rules: string[];
}

const PROMOTION_ASSOCIATIONS = associations([
  "salesChannels",
  "discounts",
  "personaRules",
  "cartRules",
  "orderRules",
]);

const PROMOTION_CRITERIA = {
  associations: PROMOTION_ASSOCIATIONS,
  includes: {
    promotion: [
      "id",
      "name",
      "translated",
      "active",
      "validFrom",
      "validUntil",
      "useCodes",
      "useIndividualCodes",
      "maxRedemptionsGlobal",
      "orderCount",
      "maxRedemptionsPerCustomer",
      "ordersPerCustomerCount",
      "salesChannels",
      "discounts",
      "personaRules",
      "cartRules",
      "orderRules",
    ],
    promotion_sales_channel: ["salesChannelId"],
    promotion_discount: ["id"],
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
  const counts: Record<string, number> = {};
  for (const [customerId, count] of Object.entries(raw(promotion.ordersPerCustomerCount) ?? {})) {
    const value = num(count);
    if (value !== null) counts[customerId.toLowerCase()] = value;
  }
  return {
    name: translated(promotion, "name"),
    active: bool(promotion.active),
    validFrom: str(promotion.validFrom),
    validUntil: str(promotion.validUntil),
    useCodes: bool(promotion.useCodes),
    useIndividualCodes: bool(promotion.useIndividualCodes),
    maxRedemptionsGlobal: num(promotion.maxRedemptionsGlobal),
    orderCount: num(promotion.orderCount),
    maxRedemptionsPerCustomer: num(promotion.maxRedemptionsPerCustomer),
    ordersPerCustomerCount: counts,
    salesChannelIds: rawList(promotion.salesChannels)
      .map((entry) => str(entry.salesChannelId))
      .filter((id): id is string => id !== null),
    discounts: Array.isArray(promotion.discounts) ? promotion.discounts.length : null,
    rules: [...new Set(rules)],
  };
}

type FoundPromotion = PromotionInfo & { codeType: "fixed" | "individual"; redeemed: boolean };

/** The promotion behind a code: a fixed code first, then an individual code. */
async function findPromotion(client: ShopwareClient, code: string): Promise<FoundPromotion | null> {
  const fixed = await client.search<Raw>("promotion", {
    page: 1,
    limit: 1,
    filter: [equals("code", code)],
    ...PROMOTION_CRITERIA,
  });
  const promotion = fixed.items[0];
  if (promotion) return { ...mapPromotion(promotion), codeType: "fixed", redeemed: false };
  const individual = await client.search<Raw>("promotion-individual-code", {
    page: 1,
    limit: 1,
    filter: [equals("code", code)],
    associations: { promotion: { associations: PROMOTION_ASSOCIATIONS } },
    includes: {
      promotion_individual_code: ["promotion", "payload"],
      ...PROMOTION_CRITERIA.includes,
    },
  });
  const entry = individual.items[0];
  const parent = raw(entry?.promotion);
  if (!entry || !parent) return null;
  return { ...mapPromotion(parent), codeType: "individual", redeemed: raw(entry.payload) !== null };
}

/**
 * Why Shopware refuses a code, following its own checks: the permitted-promotion filters
 * (active, channel, dates, code type) and the collector's eligibility (limits, discounts).
 */
function promotionReasons(
  promotion: FoundPromotion,
  channel: ChannelInfo,
  now: Date,
  customerId: string | null,
): string[] {
  const reasons: string[] = [];
  if (promotion.active === false) reasons.push("it is inactive");
  if (promotion.validFrom && Date.parse(promotion.validFrom) > now.getTime()) {
    reasons.push(`it starts on ${promotion.validFrom.slice(0, 10)}`);
  }
  if (promotion.validUntil && Date.parse(promotion.validUntil) < now.getTime()) {
    reasons.push(`it ended on ${promotion.validUntil.slice(0, 10)}`);
  }
  if (promotion.salesChannelIds.length === 0) {
    reasons.push("it is not assigned to any sales channel");
  } else if (!promotion.salesChannelIds.includes(channel.id)) {
    reasons.push(`it is not assigned to ${channel.name ?? "this sales channel"}`);
  }
  if (promotion.useCodes === false) {
    reasons.push("it needs no code and applies automatically");
  } else if (promotion.codeType === "fixed" && promotion.useIndividualCodes === true) {
    reasons.push("it now uses individual codes, so its fixed code no longer works");
  } else if (promotion.codeType === "individual" && promotion.useIndividualCodes === false) {
    reasons.push("it now uses one fixed code, so its individual codes no longer work");
  }
  if (promotion.redeemed) reasons.push("this individual code has already been redeemed");
  const globalLimit = promotion.maxRedemptionsGlobal ?? 0;
  if (globalLimit > 0 && (promotion.orderCount ?? 0) >= globalLimit) {
    reasons.push(`it has reached its limit of ${globalLimit} redemptions`);
  }
  const customerLimit = promotion.maxRedemptionsPerCustomer ?? 0;
  const used = customerId ? (promotion.ordersPerCustomerCount[customerId.toLowerCase()] ?? 0) : 0;
  if (customerLimit > 0 && used >= customerLimit) {
    reasons.push(
      `this customer has used it ${used} ${used === 1 ? "time" : "times"}, the limit per customer`,
    );
  }
  if (promotion.discounts === 0) reasons.push("it has no discount configured");
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
  /** The country the cart ships to, when known: the guest's choice or the customer's address. */
  country: CountryInfo | null;
  products: ProductInfo[];
  /** The customer the session is logged in as, for per-customer promotion limits. */
  customerId: string | null;
  now: Date;
}

const list = (values: (string | null)[]) => values.filter(Boolean).join(", ") || "none";

/**
 * The product an error is about. Shopware keys product errors as message key plus product id;
 * the name in the parameters is a fallback, since it is in the channel's language.
 */
function productOf(error: Raw, ctx: ExplainContext): ProductInfo | null {
  const errorKey = str(error.key) ?? "";
  const name = str(raw(error.parameters)?.name);
  return (
    ctx.products.find((product) => product.id !== "" && errorKey.endsWith(product.id)) ??
    ctx.products.find((product) => product.name !== null && product.name === name) ??
    null
  );
}

function countryReason(ctx: ExplainContext, name: string | null): string {
  const channelName = ctx.channel.name ?? "this sales channel";
  const countries = list(ctx.channel.countries.map((country) => country.iso));
  const target = ctx.country;
  if (!target) {
    const assigned = ctx.channel.countries.some((country) => country.name === name);
    return assigned
      ? `${name} is assigned to ${channelName}, but the country is inactive or shipping there is switched off`
      : `${name ?? "The country"} is not among the countries of ${channelName} (${countries})`;
  }
  const label = target.name ?? target.iso ?? "The country";
  if (target.active === false) return `${label} is inactive in the shop's country settings`;
  if (!ctx.channel.countries.some((country) => country.id === target.id)) {
    return `${label} is not among the countries of ${channelName} (${countries})`;
  }
  if (target.shippingAvailable === false) {
    return `${label} is assigned to ${channelName}, but shipping there is switched off for the country`;
  }
  return `${label} is assigned to ${channelName} and active; a plugin or rule blocks the address`;
}

async function explainCode(code: string, ctx: ExplainContext): Promise<string> {
  const promotion = await findPromotion(ctx.client, code);
  if (!promotion) return `No promotion uses the code "${code}"`;
  const reasons = promotionReasons(promotion, ctx.channel, ctx.now, ctx.customerId);
  return reasons.length > 0
    ? `"${code}" belongs to "${promotion.name}", but ${reasons.join(", and ")}`
    : `"${code}" belongs to "${promotion.name}", which looks valid; Shopware still refused it`;
}

async function explain(error: Raw, ctx: ExplainContext): Promise<string | null> {
  const key = str(error.messageKey) ?? str(error.key) ?? "";
  const params = raw(error.parameters) ?? {};
  const name = str(params.name);
  switch (key) {
    case "shipping-address-blocked":
      return countryReason(ctx, name);
    case "billing-address-blocked": {
      const assigned = ctx.channel.countries.some((country) => country.name === name);
      return assigned
        ? `${name} is assigned to ${ctx.channel.name}, but the country is inactive or blocked for billing`
        : `${name ?? "The billing country"} is not among the countries of ${ctx.channel.name} (${list(ctx.channel.countries.map((country) => country.iso))})`;
    }
    case "promotion-not-found": {
      const code = str(params.code);
      return code ? explainCode(code, ctx) : null;
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
      const product = productOf(error, ctx);
      return product
        ? `${product.productNumber} is a closeout article with ${product.availableStock ?? 0} available`
        : null;
    }
    case "product-stock-reached": {
      const product = productOf(error, ctx);
      return product
        ? `Only ${product.availableStock ?? 0} of ${product.productNumber} are available; the cart lowered the quantity to ${num(params.quantity) ?? "that"}`
        : null;
    }
    case "min-order-quantity": {
      const product = productOf(error, ctx);
      return product ? `${product.productNumber} sells from ${product.minPurchase} units` : null;
    }
    case "purchase-steps-quantity": {
      const product = productOf(error, ctx);
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
      const id = str(params.id);
      const method =
        (id ? methods.find((entry) => entry.id === id) : undefined) ??
        methods.find((entry) => entry.name === name) ??
        null;
      const label = method?.name ?? name;
      const reason = str(params.reason);
      if (method?.rule) return `${label} is only available when the rule "${method.rule}" matches`;
      return reason ? `${label}: ${reason}` : null;
    }
    default:
      return null;
  }
}

async function mapProblems(errors: Raw[], ctx: ExplainContext): Promise<CartProblem[]> {
  return Promise.all(
    errors.map(async (error) => {
      const key = str(error.messageKey) ?? str(error.key) ?? "unknown";
      return {
        key,
        level: LEVELS[num(error.level) ?? 0] ?? "notice",
        blocksOrder: bool(error.block) ?? false,
        message: str(error.translatedMessage) ?? str(error.message),
        explanation: await explain(error, ctx).catch((cause: unknown) => {
          // A refused lookup (often a missing read privilege) costs the explanation, not the answer.
          logger.warn("could not explain a cart error", { key, error: String(cause) });
          return null;
        }),
      };
    }),
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

/**
 * The advanced-price tier a quantity falls into, as the product page shows it. The Store API
 * sorts tiers by their start and gives each its end as quantity; the open-ended last tier
 * carries its start instead, so ranges are rebuilt from the previous tier's end.
 */
export function tierFor(tiers: Raw[], quantity: number) {
  const sorted = tiers
    .map((tier) => ({ bound: num(tier.quantity), unitPrice: num(tier.unitPrice) }))
    .filter(
      (tier): tier is { bound: number; unitPrice: number } =>
        tier.bound !== null && tier.unitPrice !== null,
    )
    .sort((a, b) => a.bound - b.bound);
  for (const [index, tier] of sorted.entries()) {
    const start = index === 0 ? 1 : (sorted[index - 1]?.bound ?? 0) + 1;
    const last = index === sorted.length - 1;
    if (last || quantity <= tier.bound) {
      return {
        unitPrice: tier.unitPrice,
        label: last ? `from ${start} units` : `${start} to ${tier.bound} units`,
      };
    }
  }
  return null;
}

/** Wait for every call before throwing, so no request is still in flight when the cart goes. */
async function settleAll<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }],
): Promise<T> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** A few variant numbers of a parent product, to say which one to pick instead. */
async function variantNumbers(client: ShopwareClient, parentId: string): Promise<string[]> {
  const variants = await client.search<Raw>("product", {
    page: 1,
    limit: 3,
    filter: [equals("parentId", parentId)],
    sort: [{ field: "productNumber", order: "ASC" }],
    includes: { product: ["productNumber"] },
  });
  return variants.items
    .map((variant) => str(variant.productNumber))
    .filter((value): value is string => value !== null);
}

const sameNumber = (a: string | null, b: string | undefined) =>
  a !== null && b !== undefined && a.toLowerCase() === b.toLowerCase();

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
    "deleted afterwards; as a customer, extensions that react to saved carts (abandoned-cart " +
    "mailers) see it like any other cart of that customer. Use it for 'why can't this customer order?', 'why does this code not " +
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
    const channels = await loadChannels(client);
    const channel = pickChannel(channels, input.salesChannel);
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

    const countryIncludes = ["id", "iso", "name", "translated", "active", "shippingAvailable"];
    const [products, country, customer, countries] = await Promise.all([
      loadProducts(client, input.items),
      input.country
        ? client.findOne<Raw>("country", "iso", input.country.toUpperCase(), {
            includes: { country: countryIncludes },
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
              country: countryIncludes,
            },
          })
        : Promise.resolve(null),
      loadCountries(client, channel.id),
    ]);
    channel.countries = countries;

    const lineItems = input.items.map((item) => {
      const product = products.find((entry) =>
        item.productId
          ? entry.id === item.productId
          : sameNumber(entry.productNumber, item.productNumber),
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

    // Shopware logs only active customers in, and only in their bound channel; anyone else
    // silently becomes a guest, which is exactly what "why can't X order?" has to say.
    let loggedIn = false;
    if (customer) {
      const number = str(customer.customerNumber) ?? input.customerNumber;
      const boundTo = str(customer.boundSalesChannelId);
      if (bool(customer.active) === false) {
        problems.push({
          key: "customer-inactive",
          level: "error",
          blocksOrder: true,
          message: `Customer ${number} is inactive and cannot log in.`,
          explanation:
            "Shopware does not log inactive customers in (the account may still wait for its double opt-in confirmation); the cart below is priced for a guest",
        });
      } else if (boundTo && boundTo !== channel.id) {
        const other = channels.find((entry) => entry.id === boundTo)?.name;
        problems.push({
          key: "customer-bound-to-other-channel",
          level: "error",
          blocksOrder: true,
          message: `Customer ${number} is bound to ${other ?? "another sales channel"} and cannot log in to ${channel.name}.`,
          explanation:
            "An account bound to one sales channel only works there; the cart below is priced for a guest",
        });
      } else {
        loggedIn = true;
      }
    }

    const toCountry = (entry: Raw | null): CountryInfo | null =>
      entry
        ? {
            id: str(entry.id) ?? "",
            iso: str(entry.iso),
            name: translated(entry, "name"),
            active: bool(entry.active),
            shippingAvailable: bool(entry.shippingAvailable),
          }
        : null;
    const shipTo = country
      ? toCountry(country)
      : customer && loggedIn
        ? toCountry(raw(raw(customer.defaultShippingAddress)?.country))
        : null;

    const session = new StoreSession(client, channel.id, channel.languageId);
    let discarded = false;
    try {
      if (customer && loggedIn) await session.switchCustomer(String(customer.id));
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
      const [payments, shippings, listing] = await settleAll<[Raw, Raw, Raw]>([
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

      const errors = cartErrors(cart);
      const explainCtx: ExplainContext = {
        client,
        channel,
        country: shipTo,
        products,
        customerId: customer && loggedIn ? String(customer.id) : null,
        now,
      };
      problems.push(...(await mapProblems(errors, explainCtx)));

      const listed = new Map(
        rawList(listing.elements).map((element) => [str(element.id) ?? "", element]),
      );
      const cartLines = rawList(cart.lineItems);
      const missing: ProductInfo[] = [];
      const items = lineItems.map(({ product, quantity }) => {
        const line = cartLines.find(
          (entry) => entry.type === "product" && entry.referencedId === product.id,
        );
        if (!line) missing.push(product);
        const price = raw(line?.price);
        const element = listed.get(product.id);
        const unitPrice = round(num(price?.unitPrice));
        // With advanced prices the product page shows the tier for the quantity, not the base price.
        const tier = tierFor(rawList(element?.calculatedPrices), num(line?.quantity) ?? quantity);
        const listingPrice = tier
          ? round(tier.unitPrice)
          : round(num(raw(element?.calculatedPrice)?.unitPrice));
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
            message: `${product.productNumber} shows ${listingPrice} per unit${tier ? ` (tier ${tier.label})` : ""} but costs ${unitPrice} in the cart.`,
            explanation:
              "A price rule, plugin or price overwrite changes the price in the cart that the product page does not show",
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
          priceTier: tier?.label ?? null,
        };
      });

      // Shopware drops some products without an error, a parent with variants above all.
      for (const product of missing) {
        const explained = errors.some(
          (error) =>
            (str(error.key) ?? "").endsWith(product.id) ||
            str(raw(error.parameters)?.id) === product.id,
        );
        if (explained) continue;
        if ((product.childCount ?? 0) > 0) {
          const examples = await variantNumbers(client, product.id).catch(() => []);
          problems.push({
            key: "product-has-variants",
            level: "error",
            blocksOrder: true,
            message: `${product.productNumber} has ${product.childCount} variants and cannot be bought itself.`,
            explanation: `Shopware removes a parent product from the cart without a message; put a variant in the cart instead${examples.length > 0 ? `, e.g. ${examples.join(", ")}` : ""}`,
          });
        } else {
          const reasons = productReasons(product, channel, now);
          problems.push({
            key: "product-not-in-cart",
            level: "error",
            blocksOrder: true,
            message: `${product.productNumber} did not make it into the cart.`,
            explanation:
              reasons.length > 0
                ? reasons.join(", and ")
                : "Shopware removed it without a message; a plugin or the product's data may keep it out",
          });
        }
      }

      const promotions = cartLines
        .filter((entry) => entry.type === "promotion")
        .map((entry) => ({
          code: str(raw(entry.payload)?.code) ?? str(entry.referencedId),
          label: str(entry.label),
          discount: round(num(raw(entry.price)?.totalPrice)),
        }));

      // Shopware keys every refused code as the same error, so the cart names only the last
      // one; each code that is neither applied nor named gets its own explanation here.
      const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
      const named = errors
        .filter((error) => str(error.messageKey) === "promotion-not-found")
        .map((error) => str(raw(error.parameters)?.code));
      for (const code of input.promotionCodes ?? []) {
        if (promotions.some((entry) => same(entry.code, code))) continue;
        if (named.some((entry) => same(entry, code))) continue;
        problems.push({
          key: "promotion-not-found",
          level: "error",
          blocksOrder: false,
          message: `Promo code "${code}" was not applied.`,
          explanation: await explainCode(code, explainCtx).catch((cause: unknown) => {
            logger.warn("could not explain a promotion code", { error: String(cause) });
            return null;
          }),
        });
      }

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
              loggedIn,
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
    "parentId",
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
    const session = new StoreSession(client, channel.id, channel.languageId);
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
    // Search groups variants and shows one per product; a sibling or the parent stands in.
    const family = product.parentId ?? product.id;
    let position = elements.findIndex((element) => element.id === product.id);
    let shownAs: string | null = null;
    if (position < 0) {
      position = elements.findIndex(
        (element) => element.parentId === family || element.id === product.parentId,
      );
      if (position >= 0) shownAs = str(elements[position]?.productNumber);
    }
    if (position >= 0) {
      return {
        salesChannel: channelView,
        term: input.term,
        total,
        items,
        explain: {
          productNumber: product.productNumber ?? wanted,
          found: true,
          position: position + 1,
          page: Math.floor(position / 24) + 1,
          ...(shownAs ? { shownAs } : {}),
          reasons: shownAs
            ? [`search shows one variant per product; ${shownAs} stands for its variants here`]
            : [],
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
      explain: { productNumber: product.productNumber ?? wanted, found: false, reasons },
    };
  },
});
