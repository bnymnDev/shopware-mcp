import { buildCriteria, equalsAny, searchInputShape } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { ShopwareMcpError } from "../errors.js";
import { logger } from "../logger.js";
import { bool, num, raw, rawList, str, toPage, translated, withFields } from "./shared.js";
import { defineTool } from "./types.js";

/** Count directly assigned products per category via one terms aggregation. */
async function productCounts(
  client: ShopwareClient,
  categoryIds: string[],
): Promise<Map<string, number> | null> {
  if (categoryIds.length === 0) return new Map();
  try {
    const result = await client.search<Raw>("product", {
      page: 1,
      limit: 1,
      "total-count-mode": 0,
      filter: [equalsAny("categories.id", categoryIds)],
      includes: { product: ["id"] },
      aggregations: [{ name: "byCategory", type: "terms", field: "categories.id" }],
    });
    const counts = new Map<string, number>();
    for (const bucket of rawList(raw(result.aggregations.byCategory)?.buckets)) {
      const key = str(bucket.key);
      const count = num(bucket.count);
      if (key && count !== null) counts.set(key, count);
    }
    return counts;
  } catch (error) {
    if (error instanceof ShopwareMcpError) {
      logger.debug("category product counts unavailable", { code: error.code });
      return null;
    }
    throw error;
  }
}

export function mapCategory(category: Raw, counts: Map<string, number> | null) {
  const id = str(category.id);
  return {
    id,
    name: translated(category, "name"),
    parentId: str(category.parentId),
    level: num(category.level),
    path: str(category.path),
    type: str(category.type),
    active: bool(category.active),
    visible: bool(category.visible),
    childCount: num(category.childCount),
    productAssignmentType: str(category.productAssignmentType),
    productCount: counts ? (id ? (counts.get(id) ?? 0) : null) : null,
  };
}

export const categoriesList = defineTool({
  name: "categories_list",
  title: "List categories",
  description:
    "List categories as a flat list with parentId and level so you can rebuild the tree. Each " +
    "item includes productCount (directly assigned products). Filter by parentId to get one " +
    "level, or by level=1 for the roots. Returns { total, page, limit, items[] }.",
  inputSchema: searchInputShape,
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [
        { field: "level", order: "ASC" },
        { field: "name", order: "ASC" },
      ],
    });
    const result = await ctx.client.search<Raw>("category", criteria);
    const ids = result.items.map((item) => str(item.id)).filter((id): id is string => id !== null);
    const counts = await productCounts(ctx.client, ids);
    const page = toPage(result, criteria, (category) =>
      withFields(mapCategory(category, counts), category, input.fields),
    );
    return counts
      ? page
      : { ...page, warnings: ["productCount unavailable: product aggregation failed"] };
  },
});
