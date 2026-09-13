import { z } from "zod";
import { associations, buildCriteria, searchInputShape } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { avgOf } from "./aggregations.js";
import {
  bool,
  dryRunField,
  fullName,
  idSchema,
  num,
  raw,
  str,
  toPage,
  translated,
  withFields,
} from "./shared.js";
import { type DryRunResult, defineTool } from "./types.js";

export const REVIEW_ASSOCIATIONS = associations(["product", "customer", "salesChannel"]);

export function mapReview(review: Raw) {
  const product = raw(review.product);
  const customer = raw(review.customer);
  return {
    id: str(review.id),
    productId: str(review.productId),
    productNumber: str(product?.productNumber),
    product: translated(product, "name"),
    title: str(review.title),
    content: str(review.content),
    points: num(review.points),
    /** true = approved and shown in the storefront, false = awaiting moderation. */
    approved: bool(review.status),
    reviewer: fullName(customer) ?? str(review.externalUser),
    customerId: str(review.customerId),
    salesChannel: translated(raw(review.salesChannel), "name"),
    comment: str(review.comment),
    createdAt: str(review.createdAt),
  };
}

export async function fetchReview(client: ShopwareClient, reviewId: string) {
  const review = await client.findById<Raw>("product-review", reviewId, {
    associations: REVIEW_ASSOCIATIONS,
  });
  return mapReview(review);
}

export const reviewsSearch = defineTool({
  name: "reviews_search",
  title: "Search product reviews",
  description:
    "Search product reviews with their rating (1-5 points), text, reviewer, product and " +
    "moderation state. Filter on status (false = awaiting approval), points, productId, " +
    "product.productNumber or createdAt ranges. Newest first. Adds averagePoints over the " +
    "whole match. Use review_moderate to approve or hide one. " +
    "Returns { total, page, limit, averagePoints, items[] }.",
  inputSchema: searchInputShape,
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "createdAt", order: "DESC" }],
      associations: REVIEW_ASSOCIATIONS,
      aggregations: [{ name: "points", type: "avg", field: "points" }],
    });
    const result = await ctx.client.search<Raw>("product-review", criteria);
    const average = avgOf(result.aggregations.points);
    return {
      ...toPage(result, criteria, (review) => withFields(mapReview(review), review, input.fields)),
      averagePoints: average === null ? null : Math.round(average * 100) / 100,
    };
  },
});

export const reviewModerate = defineTool({
  name: "review_moderate",
  title: "Moderate review (guarded)",
  description:
    "Approve or hide one product review (sets its status; approved reviews are shown in the " +
    "storefront) and optionally set the shop's public reply comment. dryRun=true (default) " +
    "returns the exact PATCH request without changing anything; call again with dryRun=false " +
    "to apply. Returns { dryRun, wouldSend } or { dryRun: false, result: <updated review> }.",
  write: true,
  inputSchema: {
    reviewId: idSchema.describe("Review UUID"),
    approved: z.boolean().describe("true to publish, false to hide"),
    comment: z
      .string()
      .max(5000)
      .optional()
      .describe("Public reply shown under the review; omit to leave it unchanged"),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const path = `/api/product-review/${input.reviewId}`;
    const body: Raw = { status: input.approved };
    if (input.comment !== undefined) body.comment = input.comment;
    if (input.dryRun) {
      const dry: DryRunResult = {
        dryRun: true,
        wouldSend: { method: "PATCH", url: ctx.client.url(path), body },
      };
      return dry;
    }
    await ctx.client.request(path, { method: "PATCH", body });
    return { dryRun: false, result: await fetchReview(ctx.client, input.reviewId) };
  },
});
