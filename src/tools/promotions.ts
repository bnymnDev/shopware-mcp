import { z } from "zod";
import { associations, buildCriteria, searchInputShape } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import {
  bool,
  dryRunField,
  idSchema,
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
