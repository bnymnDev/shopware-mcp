import { z } from "zod";
import { associations } from "../client/criteria.js";
import { INHERITANCE_HEADERS, type Raw, type ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { bool, dryRunField, idSchema, num, rawList, sortByKey, str, translated } from "./shared.js";
import { type DryRunResult, defineTool } from "./types.js";

const STOCK_ASSOCIATIONS = associations(["children.options.group"]);

function mapVariantStock(variant: Raw) {
  return {
    id: str(variant.id),
    productNumber: str(variant.productNumber),
    name: translated(variant, "name"),
    options: rawList(variant.options)
      .map((option) => translated(option, "name"))
      .filter((name): name is string => name !== null),
    stock: num(variant.stock),
    availableStock: num(variant.availableStock),
    available: bool(variant.available),
    active: bool(variant.active),
  };
}

export function mapStock(product: Raw) {
  return {
    id: str(product.id),
    productNumber: str(product.productNumber),
    name: translated(product, "name"),
    parentId: str(product.parentId),
    stock: num(product.stock),
    availableStock: num(product.availableStock),
    available: bool(product.available),
    active: bool(product.active),
    isCloseout: bool(product.isCloseout),
    restockTime: num(product.restockTime),
    variants: sortByKey(rawList(product.children), "productNumber").map(mapVariantStock),
  };
}

export async function fetchStock(
  client: ShopwareClient,
  lookup: { productId?: string; productNumber?: string },
) {
  const criteria = { associations: STOCK_ASSOCIATIONS };
  const product = lookup.productId
    ? await client.findById<Raw>("product", lookup.productId, criteria, INHERITANCE_HEADERS)
    : await client.findOne<Raw>(
        "product",
        "productNumber",
        lookup.productNumber ?? "",
        criteria,
        INHERITANCE_HEADERS,
      );
  return mapStock(product);
}

export const stockGet = defineTool({
  name: "stock_get",
  title: "Get stock",
  description:
    "Get stock and available stock for one product by ID or product number, including every " +
    "variant. Use it for 'how many X are left?' questions. Returns one object with a variants[] " +
    "list (empty for simple products).",
  inputSchema: {
    productId: idSchema.optional().describe("Product UUID"),
    productNumber: z.string().min(1).optional().describe("Product number, e.g. SW10001"),
  },
  handler: async (input, ctx) => {
    if (!input.productId && !input.productNumber) {
      throw badRequest("Provide productId or productNumber");
    }
    return fetchStock(ctx.client, input);
  },
});

export const stockSet = defineTool({
  name: "stock_set",
  title: "Set stock (guarded)",
  description:
    "Set the absolute stock of one product or variant. dryRun=true (default) returns the exact " +
    "PATCH request without changing anything; call again with dryRun=false to apply. " +
    "Returns { dryRun, wouldSend } or { dryRun: false, result: <product stock> }.",
  write: true,
  inputSchema: {
    productId: idSchema.describe("Product or variant UUID"),
    stock: z.number().int().min(0).describe("New absolute stock quantity"),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const path = `/api/product/${input.productId}`;
    const body = { stock: input.stock };
    if (input.dryRun) {
      const dry: DryRunResult = {
        dryRun: true,
        wouldSend: { method: "PATCH", url: ctx.client.url(path), body },
      };
      return dry;
    }
    await ctx.client.request(path, { method: "PATCH", body });
    return { dryRun: false, result: await fetchStock(ctx.client, { productId: input.productId }) };
  },
});
