import { z } from "zod";
import { STOREFRONT_TYPE_ID } from "../client/constants.js";
import { equals } from "../client/criteria.js";
import { INHERITANCE_HEADERS, type Raw, type ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { defaultPrice, readAll } from "./margins.js";
import { idSchema, num, raw, rawList, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

/**
 * A product as AI shopping agents and their feeds want it: the field names of the Agentic
 * Commerce product feed (OpenAI, Stripe), which are close to Google Merchant's. One row per
 * product or variant.
 */
export interface FeedRow {
  item_id: string;
  title: string;
  description: string;
  url: string;
  brand?: string;
  seller_name: string;
  image_url?: string;
  additional_image_urls?: string[];
  availability: "in_stock" | "out_of_stock" | "backorder";
  price: string;
  gtin?: string;
  mpn?: string;
  weight?: string;
  item_weight_unit?: "kg";
  group_id?: string;
  listing_has_variations?: true;
  variant_dict?: Record<string, string>;
  seller_privacy_policy?: string;
  seller_tos?: string;
  return_policy?: string;
}

/** A GTIN (EAN, UPC) with 8, 12, 13 or 14 digits and a correct check digit. */
export function validGtin(value: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop() ?? -1;
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Plain text from a product description, which Shopware stores as HTML. */
export function plainText(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

interface Channel {
  id: string;
  name: string;
  url: string | null;
  currency: string;
}

async function storefront(client: ShopwareClient, salesChannelId?: string): Promise<Channel> {
  const result = await client.search<Raw>("sales-channel", {
    page: 1,
    limit: 25,
    filter: salesChannelId
      ? [equals("id", salesChannelId)]
      : [equals("typeId", STOREFRONT_TYPE_ID)],
    associations: { domains: {}, currency: {} },
  });
  const channel = result.items.find((item) => item.active !== false) ?? result.items[0];
  if (!channel) throw badRequest(salesChannelId ? "Unknown sales channel" : "No storefront found");
  const domains = rawList(channel.domains)
    .map((domain) => str(domain.url))
    .filter((url): url is string => Boolean(url));
  return {
    id: str(channel.id) ?? "",
    name: translated(channel, "name") ?? "Storefront",
    url: domains.find((url) => url.startsWith("https://")) ?? domains[0] ?? null,
    currency: str(raw(channel.currency)?.isoCode) ?? "EUR",
  };
}

/** The pages a checkout through an agent needs: privacy, terms, and the revocation policy. */
async function policyPages(client: ShopwareClient, channel: Channel) {
  const config = await client
    .request<Raw>(
      `/api/_action/system-config?domain=core.basicInformation&salesChannelId=${channel.id}&inherit=1`,
    )
    .catch(() => null);
  if (!config) return null;
  const page = (key: string) => {
    const id = str(config[`core.basicInformation.${key}`]);
    return id && channel.url ? `${channel.url}/widgets/cms/${id}` : null;
  };
  return {
    shopName: str(config["core.basicInformation.shopName"]),
    privacy: page("privacyPage"),
    tos: page("tosPage"),
    returns: page("revocationPage"),
  };
}

const money = (value: number, currency: string) => `${value.toFixed(2)} ${currency}`;

/** Read the products a storefront shows and turn each into a feed row. */
export async function buildFeed(
  client: ShopwareClient,
  options: { salesChannelId?: string; limit?: number },
) {
  const channel = await storefront(client, options.salesChannelId);
  const policies = await policyPages(client, channel);
  const products = await readAll(
    client,
    "product",
    {
      filter: [
        equals("active", true),
        equals("visibilities.salesChannelId", channel.id),
        {
          type: "multi",
          operator: "or",
          queries: [equals("childCount", 0), equals("childCount", null)],
        },
      ],
      associations: {
        manufacturer: {},
        cover: { associations: { media: {} } },
        media: { associations: { media: {} } },
        options: { associations: { group: {} } },
        seoUrls: {
          filter: [
            equals("salesChannelId", channel.id),
            equals("isCanonical", true),
            equals("isDeleted", false),
          ],
        },
      },
      ...(options.limit ? { limit: options.limit } : {}),
    },
    INHERITANCE_HEADERS,
  );
  // Variants name their group by the parent's number; Shopware will not join the parent.
  const parentIds = [
    ...new Set(products.items.map((product) => str(product.parentId)).filter(Boolean)),
  ] as string[];
  const parentNumbers = new Map<string, string>();
  for (let start = 0; start < parentIds.length; start += 500) {
    const parents = await client.search<Raw>("product", {
      page: 1,
      limit: 500,
      filter: [{ type: "equalsAny", field: "id", value: parentIds.slice(start, start + 500) }],
      includes: { product: ["id", "productNumber"] },
    });
    for (const parent of parents.items) {
      const id = str(parent.id);
      const number = str(parent.productNumber);
      if (id && number) parentNumbers.set(id, number);
    }
  }
  const seller = policies?.shopName ?? channel.name;
  const base = channel.url ?? "";
  const rows: FeedRow[] = [];
  const raws: Raw[] = [];
  for (const product of products.items.slice(0, options.limit ?? products.items.length)) {
    const id = str(product.productNumber) ?? str(product.id) ?? "";
    const seo = str(rawList(product.seoUrls)[0]?.seoPathInfo);
    const price = defaultPrice(product.price);
    const stock = num(product.availableStock) ?? 0;
    const closeout = product.isCloseout === true;
    const cover = str(raw(raw(product.cover)?.media)?.url);
    const others = rawList(product.media)
      .map((entry) => str(raw(entry.media)?.url))
      .filter((url): url is string => Boolean(url) && url !== cover);
    const options_ = rawList(product.options);
    const ean = str(product.ean)?.trim();
    const weight = num(product.weight);
    const row: FeedRow = {
      item_id: id,
      title: [
        translated(product, "name") ?? "",
        // A variant's title names its options, as the product page does: "Shirt Blue M".
        ...(product.parentId ? options_.map((option) => translated(option, "name") ?? "") : []),
      ]
        .filter(Boolean)
        .join(" "),
      description: plainText(translated(product, "description") ?? ""),
      url: `${base}/${seo ?? `detail/${str(product.id)}`}`,
      seller_name: seller,
      availability: stock > 0 ? "in_stock" : closeout ? "out_of_stock" : "backorder",
      price: price ? money(price.gross, channel.currency) : "",
      ...(translated(raw(product.manufacturer), "name")
        ? { brand: translated(raw(product.manufacturer), "name") ?? "" }
        : {}),
      ...(cover ? { image_url: cover } : {}),
      ...(others.length > 0 ? { additional_image_urls: others.slice(0, 10) } : {}),
      ...(ean ? { gtin: ean } : {}),
      ...(str(product.manufacturerNumber) ? { mpn: str(product.manufacturerNumber) ?? "" } : {}),
      ...(weight && weight > 0 ? { weight: String(weight), item_weight_unit: "kg" as const } : {}),
      ...(product.parentId
        ? {
            group_id: parentNumbers.get(str(product.parentId) ?? "") ?? str(product.parentId) ?? "",
            listing_has_variations: true as const,
            variant_dict: Object.fromEntries(
              options_.map((option) => [
                translated(raw(option.group), "name") ?? "option",
                translated(option, "name") ?? "",
              ]),
            ),
          }
        : {}),
      ...(policies?.privacy ? { seller_privacy_policy: policies.privacy } : {}),
      ...(policies?.tos ? { seller_tos: policies.tos } : {}),
      ...(policies?.returns ? { return_policy: policies.returns } : {}),
    };
    rows.push(row);
    raws.push(product);
  }
  return { channel, policies, rows, total: products.total };
}

interface Gap {
  field: string;
  level: "required" | "checkout" | "recommended";
  why: string;
  test: (row: FeedRow) => boolean;
}

/** What is checked per row, and why an agent cares. */
const GAPS: Gap[] = [
  { field: "title", level: "required", why: "no name", test: (row) => row.title.length === 0 },
  {
    field: "title_length",
    level: "recommended",
    why: "longer than 150 characters, agents cut it",
    test: (row) => row.title.length > 150,
  },
  {
    field: "description",
    level: "required",
    why: "no description, an agent cannot say what it is",
    test: (row) => row.description.length === 0,
  },
  {
    field: "description_short",
    level: "recommended",
    why: "description under 100 characters, too thin to answer questions about it",
    test: (row) => row.description.length > 0 && row.description.length < 100,
  },
  {
    field: "brand",
    level: "required",
    why: "no manufacturer, the feed's brand",
    test: (row) => !row.brand,
  },
  { field: "image_url", level: "required", why: "no cover image", test: (row) => !row.image_url },
  { field: "price", level: "required", why: "no price", test: (row) => !row.price },
  {
    field: "gtin",
    level: "recommended",
    why: "no GTIN (EAN), agents match products across shops by it",
    test: (row) => !row.gtin,
  },
  {
    field: "gtin_invalid",
    level: "recommended",
    why: "GTIN with a wrong length or check digit, feeds reject it",
    test: (row) => Boolean(row.gtin) && !validGtin(row.gtin ?? ""),
  },
  {
    field: "mpn",
    level: "recommended",
    why: "neither GTIN nor manufacturer number, so nothing identifies it outside the shop",
    test: (row) => !row.gtin && !row.mpn,
  },
  {
    field: "weight",
    level: "recommended",
    why: "no weight, shipping costs cannot be worked out",
    test: (row) => !row.weight,
  },
];

export async function agentReadiness(
  client: ShopwareClient,
  input: { salesChannelId?: string; maxItems: number },
) {
  const { channel, policies, rows, total } = await buildFeed(client, {
    ...(input.salesChannelId ? { salesChannelId: input.salesChannelId } : {}),
  });
  const gaps = GAPS.map((gap) => {
    const hits = rows.filter(gap.test);
    return {
      field: gap.field,
      level: gap.level,
      why: gap.why,
      count: hits.length,
      share: rows.length === 0 ? 0 : Math.round((hits.length / rows.length) * 1000) / 10,
      sample: hits
        .slice(0, input.maxItems)
        .map((row) => ({ item_id: row.item_id, title: row.title })),
    };
  }).filter((gap) => gap.count > 0);
  const required = GAPS.filter((gap) => gap.level === "required");
  const ready = rows.filter((row) => !required.some((gap) => gap.test(row))).length;

  const shop = [
    {
      check: "https",
      ok: channel.url?.startsWith("https://") ?? false,
      detail: channel.url ?? "the storefront has no domain",
    },
    {
      check: "privacy_policy",
      ok: Boolean(policies?.privacy),
      detail: policies
        ? (policies.privacy ?? "no privacy page assigned")
        : "not readable (system_config:read)",
    },
    {
      check: "terms",
      ok: Boolean(policies?.tos),
      detail: policies
        ? (policies.tos ?? "no terms page assigned")
        : "not readable (system_config:read)",
    },
    {
      check: "return_policy",
      ok: Boolean(policies?.returns),
      detail: policies
        ? (policies.returns ?? "no revocation page assigned")
        : "not readable (system_config:read)",
    },
  ];
  const shopOk = shop.filter((check) => check.ok).length;
  const productShare = rows.length === 0 ? 0 : ready / rows.length;
  const recommendedHits =
    rows.length === 0
      ? 0
      : GAPS.filter((gap) => gap.level === "recommended").reduce(
          (sum, gap) => sum + rows.filter(gap.test).length,
          0,
        ) /
        (rows.length * GAPS.filter((gap) => gap.level === "recommended").length);
  // Required fields weigh most, the shop's pages next, recommended fields last.
  const score = Math.round(
    60 * productShare + 25 * (shopOk / shop.length) + 15 * (1 - recommendedHits),
  );

  return {
    salesChannel: { id: channel.id, name: channel.name, url: channel.url },
    score,
    products: {
      checked: rows.length,
      ...(total > rows.length ? { sampled: true, total } : {}),
      readyForDiscovery: ready,
      readyShare: Math.round(productShare * 1000) / 10,
    },
    gaps,
    shop,
    checkoutReady: shop.every((check) => check.ok),
    feedSample: rows.slice(0, Math.min(2, input.maxItems)).map((row) => ({
      ...row,
      description:
        row.description.length > 300 ? `${row.description.slice(0, 300)}…` : row.description,
    })),
    note:
      "Checked against the Agentic Commerce product feed (OpenAI, Stripe), whose fields match " +
      "Google Merchant's; Google's Universal Commerce Protocol reads the same product data. " +
      "`shopware-mcp feed --out feed.jsonl` writes the whole feed. Prices are the gross " +
      "prices in the default currency.",
  };
}

export const agentReadinessTool = defineTool({
  name: "agent_readiness",
  title: "Ready for AI shopping agents?",
  description:
    "Can AI shopping agents (ChatGPT, Gemini, Perplexity, Copilot) find and sell this shop's " +
    "products? Builds the product feed agents read (Agentic Commerce feed fields, as Google " +
    "Merchant) from the storefront's visible products and checks each row: name, description, " +
    "brand, image and price are required; GTIN with a valid check digit, manufacturer number " +
    "and weight help agents match and ship. Also checks HTTPS and the privacy, terms and " +
    "revocation pages an agent checkout links to. Read-only. Returns { score (0 to 100), " +
    "products, gaps[] with share and samples, shop[], checkoutReady, feedSample[] }.",
  inputSchema: {
    salesChannelId: idSchema.optional().describe("Storefront to check; default: the first one"),
    maxItems: z.number().int().min(1).max(50).default(5).describe("Sample products per gap"),
  },
  handler: (input, ctx) =>
    agentReadiness(ctx.client, {
      maxItems: input.maxItems,
      ...(input.salesChannelId ? { salesChannelId: input.salesChannelId } : {}),
    }),
});
