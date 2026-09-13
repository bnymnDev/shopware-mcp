import { z } from "zod";
import { associations, buildCriteria, searchInputShape } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import {
  bool,
  dryRunField,
  idSchema,
  newId,
  num,
  rawList,
  str,
  toPage,
  translated,
  withFields,
} from "./shared.js";
import { type DryRunResult, defineTool } from "./types.js";

const ASSOCIATIONS = associations(["discounts"]);

export function mapPromotion(promotion: Raw) {
  return {
    id: str(promotion.id),
    name: translated(promotion, "name"),
    active: bool(promotion.active),
    validFrom: str(promotion.validFrom),
    validUntil: str(promotion.validUntil),
    code: str(promotion.code),
    useCodes: bool(promotion.useCodes),
    useIndividualCodes: bool(promotion.useIndividualCodes),
    individualCodePattern: str(promotion.individualCodePattern),
    useSetGroups: bool(promotion.useSetGroups),
    priority: num(promotion.priority),
    exclusive: bool(promotion.exclusive),
    maxRedemptionsGlobal: num(promotion.maxRedemptionsGlobal),
    maxRedemptionsPerCustomer: num(promotion.maxRedemptionsPerCustomer),
    orderCount: num(promotion.orderCount),
    discounts: rawList(promotion.discounts).map((discount) => ({
      id: str(discount.id),
      scope: str(discount.scope),
      type: str(discount.type),
      value: num(discount.value),
      maxValue: num(discount.maxValue),
      considerAdvancedRules: bool(discount.considerAdvancedRules),
    })),
  };
}

export async function fetchPromotion(client: ShopwareClient, promotionId: string) {
  const promotion = await client.findById<Raw>("promotion", promotionId, {
    associations: ASSOCIATIONS,
  });
  return mapPromotion(promotion);
}

export const promotionsList = defineTool({
  name: "promotions_list",
  title: "List promotions",
  description:
    "List promotions (discount campaigns) with code settings, validity window, redemption " +
    "limits and a summary of their discounts (scope, type, value). Filter by active or code. " +
    "Returns { total, page, limit, items[] }.",
  inputSchema: searchInputShape,
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "name", order: "ASC" }],
      associations: ASSOCIATIONS,
    });
    const result = await ctx.client.search<Raw>("promotion", criteria);
    return toPage(result, criteria, (promotion) =>
      withFields(mapPromotion(promotion), promotion, input.fields),
    );
  },
});

export const promotionToggle = defineTool({
  name: "promotion_toggle",
  title: "Toggle promotion (guarded)",
  description:
    "Activate or deactivate one promotion. dryRun=true (default) returns the exact PATCH " +
    "request without changing anything; call again with dryRun=false to apply. " +
    "Returns { dryRun, wouldSend } or { dryRun: false, result: <updated promotion> }.",
  write: true,
  inputSchema: {
    promotionId: idSchema.describe("Promotion UUID"),
    active: z.boolean().describe("true to activate, false to deactivate"),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const path = `/api/promotion/${input.promotionId}`;
    const body = { active: input.active };
    if (input.dryRun) {
      const dry: DryRunResult = {
        dryRun: true,
        wouldSend: { method: "PATCH", url: ctx.client.url(path), body },
      };
      return dry;
    }
    await ctx.client.request(path, { method: "PATCH", body });
    return { dryRun: false, result: await fetchPromotion(ctx.client, input.promotionId) };
  },
});

const discountInput = z
  .object({
    type: z.enum(["percentage", "absolute"]).describe("percentage of the cart or a fixed amount"),
    value: z.number().positive().describe("Percent (e.g. 10 for 10 %) or amount in shop currency"),
    maxValue: z
      .number()
      .positive()
      .optional()
      .describe("Cap for percentage discounts, in shop currency"),
  })
  .describe("One discount on the whole cart");

export const promotionCreate = defineTool({
  name: "promotion_create",
  title: "Create promotion (guarded)",
  description:
    "Create a cart promotion with one discount: a name, an optional single code (without a " +
    "code the discount applies automatically), percentage or absolute value, validity window, " +
    "redemption limits and the sales channels it runs in (required; use sales_channels_list). " +
    "Created inactive unless active=true, so it can be reviewed first. dryRun=true (default) " +
    "returns the exact POST request without changing anything; call again with dryRun=false " +
    "to apply. Returns { dryRun, wouldSend } or { dryRun: false, result: <new promotion> }.",
  write: true,
  annotations: { idempotentHint: false },
  inputSchema: {
    name: z.string().min(1).max(255),
    code: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, - and _ only")
      .optional()
      .describe("Voucher code customers enter; omit for an automatic promotion"),
    discount: discountInput,
    salesChannelIds: z.array(idSchema).min(1).max(50).describe("Sales channels it runs in"),
    validFrom: z.string().optional().describe("ISO date-time; omit for 'now'"),
    validUntil: z.string().optional().describe("ISO date-time; omit for 'no end'"),
    maxRedemptionsGlobal: z.number().int().min(1).optional(),
    maxRedemptionsPerCustomer: z.number().int().min(1).optional(),
    active: z.boolean().default(false),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const id = newId();
    const body: Raw = {
      id,
      name: input.name,
      active: input.active,
      useCodes: input.code !== undefined,
      useIndividualCodes: false,
      useSetGroups: false,
      exclusive: false,
      discounts: [
        {
          scope: "cart",
          type: input.discount.type,
          value: input.discount.value,
          considerAdvancedRules: false,
          ...(input.discount.maxValue !== undefined ? { maxValue: input.discount.maxValue } : {}),
        },
      ],
      salesChannels: input.salesChannelIds.map((salesChannelId, index) => ({
        salesChannelId,
        priority: index + 1,
      })),
    };
    if (input.code !== undefined) body.code = input.code;
    if (input.validFrom !== undefined) body.validFrom = input.validFrom;
    if (input.validUntil !== undefined) body.validUntil = input.validUntil;
    if (input.maxRedemptionsGlobal !== undefined)
      body.maxRedemptionsGlobal = input.maxRedemptionsGlobal;
    if (input.maxRedemptionsPerCustomer !== undefined)
      body.maxRedemptionsPerCustomer = input.maxRedemptionsPerCustomer;
    const path = "/api/promotion";
    if (input.dryRun) {
      const dry: DryRunResult = {
        dryRun: true,
        wouldSend: { method: "POST", url: ctx.client.url(path), body },
      };
      return dry;
    }
    await ctx.client.request(path, { method: "POST", body, idempotent: false });
    return { dryRun: false, result: await fetchPromotion(ctx.client, id) };
  },
});
