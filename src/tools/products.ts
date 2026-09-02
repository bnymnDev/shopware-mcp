import { z } from "zod";
import { DEFAULT_CURRENCY_ID } from "../client/constants.js";
import { associations, buildCriteria, equals, searchInputShape } from "../client/criteria.js";
import { INHERITANCE_HEADERS, type Raw, type ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import {
  bool,
  dryRunField,
  idSchema,
  num,
  pickPrice,
  raw,
  rawList,
  sortByKey,
  str,
  toPage,
  translated,
  withFields,
} from "./shared.js";
import { type DryRunResult, defineTool } from "./types.js";

const SEARCH_ASSOCIATIONS = associations(["manufacturer", "categories", "cover.media"]);
const DETAIL_ASSOCIATIONS = associations([
  "manufacturer",
  "categories",
  "cover.media",
  "tax",
  "properties.group",
  "options.group",
  "media.media",
  "children.options.group",
]);

type Currencies = Awaited<ReturnType<ShopwareClient["currencies"]>> | null;

async function currenciesOrNull(client: ShopwareClient): Promise<Currencies> {
  try {
    return await client.currencies();
  } catch {
    return null;
  }
}

function mapOption(option: Raw) {
  return { group: translated(raw(option.group), "name"), value: translated(option, "name") };
}

export function mapProductSummary(product: Raw, currencies: Currencies) {
  return {
    id: str(product.id),
    productNumber: str(product.productNumber),
    name: translated(product, "name"),
    parentId: str(product.parentId),
    price: pickPrice(product, currencies),
    stock: num(product.stock),
    availableStock: num(product.availableStock),
    available: bool(product.available),
    active: bool(product.active),
    manufacturer: translated(raw(product.manufacturer), "name"),
    categories: rawList(product.categories)
      .map((category) => translated(category, "name"))
      .filter((name): name is string => name !== null),
    coverUrl: str(raw(raw(product.cover)?.media)?.url),
  };
}

export function mapProductDetail(product: Raw, currencies: Currencies) {
  const tax = raw(product.tax);
  return {
    ...mapProductSummary(product, currencies),
    description: translated(product, "description"),
    ean: str(product.ean),
    manufacturerNumber: str(product.manufacturerNumber),
    releaseDate: str(product.releaseDate),
    isCloseout: bool(product.isCloseout),
    shippingFree: bool(product.shippingFree),
    minPurchase: num(product.minPurchase),
    maxPurchase: num(product.maxPurchase),
    tax: tax ? { name: str(tax.name), taxRate: num(tax.taxRate) } : null,
    categories: rawList(product.categories).map((category) => ({
      id: str(category.id),
      name: translated(category, "name"),
    })),
    properties: rawList(product.properties).map(mapOption),
    options: rawList(product.options).map(mapOption),
    media: sortByKey(rawList(product.media), "position").map((entry) => {
      const media = raw(entry.media);
      return {
        id: str(entry.id),
        mediaId: str(entry.mediaId),
        url: str(media?.url),
        alt: translated(media, "alt"),
        position: num(entry.position),
      };
    }),
    variantCount: num(product.childCount),
    variants: sortByKey(rawList(product.children), "productNumber").map((child) => ({
      id: str(child.id),
      productNumber: str(child.productNumber),
      name: translated(child, "name"),
      options: rawList(child.options).map(mapOption),
      price: pickPrice(child, currencies),
      stock: num(child.stock),
      availableStock: num(child.availableStock),
      available: bool(child.available),
      active: bool(child.active),
      ean: str(child.ean),
    })),
    createdAt: str(product.createdAt),
    updatedAt: str(product.updatedAt),
  };
}

export async function fetchProductDetail(client: ShopwareClient, productId: string) {
  const [product, currencies] = await Promise.all([
    client.findById<Raw>(
      "product",
      productId,
      { associations: DETAIL_ASSOCIATIONS },
      INHERITANCE_HEADERS,
    ),
    currenciesOrNull(client),
  ]);
  return mapProductDetail(product, currencies);
}

export const productsSearch = defineTool({
  name: "products_search",
  title: "Search products",
  description:
    "Search products by free-text term and/or Criteria filters (e.g. active, stock, " +
    "manufacturer.name, categories.id, productNumber). Returns compact product summaries with " +
    "price, stock, availability, manufacturer, category names and cover image URL. " +
    "By default only main products are returned; set includeVariants=true to also get variants. " +
    "Use products_get for the full record of one product. Returns { total, page, limit, items[] }.",
  inputSchema: {
    ...searchInputShape,
    includeVariants: z
      .boolean()
      .default(false)
      .describe("Include variant products (children) in the results. Default: parents only."),
  },
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "productNumber", order: "ASC" }],
      associations: SEARCH_ASSOCIATIONS,
      extraFilters: input.includeVariants ? [] : [equals("parentId", null)],
    });
    const [result, currencies] = await Promise.all([
      ctx.client.search<Raw>("product", criteria, INHERITANCE_HEADERS),
      currenciesOrNull(ctx.client),
    ]);
    return toPage(result, criteria, (product) =>
      withFields(mapProductSummary(product, currencies), product, input.fields),
    );
  },
});

export const productsGet = defineTool({
  name: "products_get",
  title: "Get product",
  description:
    "Get one product by ID with everything an agent usually needs: description, price, stock, " +
    "tax, manufacturer, categories, properties, media and all variants with their options, " +
    "stock and price. Use products_search or stock_get to find the ID first. Returns one object.",
  inputSchema: {
    productId: idSchema.describe("Product UUID (32 hex chars)"),
    fields: searchInputShape.fields,
  },
  handler: async (input, ctx) => {
    const [product, currencies] = await Promise.all([
      ctx.client.findById<Raw>(
        "product",
        input.productId,
        { associations: DETAIL_ASSOCIATIONS },
        INHERITANCE_HEADERS,
      ),
      currenciesOrNull(ctx.client),
    ]);
    return withFields(mapProductDetail(product, currencies), product, input.fields);
  },
});

const priceInput = z
  .object({
    gross: z.number().min(0),
    net: z.number().min(0),
    currencyId: idSchema
      .optional()
      .describe("Currency UUID; defaults to the shop's default currency"),
  })
  .describe("New price for one currency; other currencies' prices are preserved");

export const productUpdate = defineTool({
  name: "product_update",
  title: "Update product (guarded)",
  description:
    "Update basic fields of one product: name, description, active flag and/or price for one " +
    "currency. Only these fields are supported. dryRun=true (default) returns the exact PATCH " +
    "request without changing anything; call again with dryRun=false to apply. " +
    "Returns { dryRun, wouldSend } or { dryRun: false, result: <updated product> }.",
  write: true,
  inputSchema: {
    productId: idSchema.describe("Product UUID"),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    price: priceInput.optional(),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const body: Raw = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.active !== undefined) body.active = input.active;
    if (input.price) {
      // Price is a JSON blob holding all currencies; merge so we do not drop other currencies.
      const current = await ctx.client.findById<Raw>("product", input.productId);
      const currencyId = input.price.currencyId ?? DEFAULT_CURRENCY_ID;
      const others = rawList(current.price).filter((entry) => entry.currencyId !== currencyId);
      body.price = [
        ...others,
        { currencyId, gross: input.price.gross, net: input.price.net, linked: false },
      ];
    }
    if (Object.keys(body).length === 0) {
      throw badRequest("Provide at least one of: name, description, active, price");
    }
    const path = `/api/product/${input.productId}`;
    if (input.dryRun) {
      const dry: DryRunResult = {
        dryRun: true,
        wouldSend: { method: "PATCH", url: ctx.client.url(path), body },
      };
      return dry;
    }
    await ctx.client.request(path, { method: "PATCH", body });
    return { dryRun: false, result: await fetchProductDetail(ctx.client, input.productId) };
  },
});
