import { z } from "zod";
import { MAX_LIMIT } from "../config.js";

/* ------------------------------------------------------------------------------------------
 * Agent-facing input schemas (shared by every search tool)
 * ---------------------------------------------------------------------------------------- */

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const rangeValue = z
  .object({
    gte: z.union([z.number(), z.string()]).optional(),
    gt: z.union([z.number(), z.string()]).optional(),
    lte: z.union([z.number(), z.string()]).optional(),
    lt: z.union([z.number(), z.string()]).optional(),
  })
  .describe("Range bounds; dates as ISO strings, e.g. { gte: '2024-01-01' }");

export const filterSchema = z.object({
  type: z
    .enum(["equals", "contains", "range", "equalsAny"])
    .describe("Shopware Criteria filter type"),
  field: z
    .string()
    .min(1)
    .describe("Entity field; dot-path for associations, e.g. 'manufacturer.name'"),
  value: z
    .union([scalar, z.array(z.union([z.string(), z.number()])), rangeValue])
    .describe(
      "equals: scalar; contains: string; equalsAny: array; range: { gte?, gt?, lte?, lt? }",
    ),
});
export type Filter = z.infer<typeof filterSchema>;

export const sortSchema = z.object({
  field: z.string().min(1),
  order: z.enum(["ASC", "DESC"]).default("ASC"),
});
export type Sort = z.infer<typeof sortSchema>;

export const searchInputShape = {
  term: z.string().min(1).optional().describe("Full-text search term"),
  filter: z.array(filterSchema).max(20).optional().describe("Criteria filters, combined with AND"),
  sort: z.array(sortSchema).max(5).optional().describe("Sort order; defaults per tool"),
  page: z.number().int().min(1).default(1).describe("1-based page"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Items per page, max ${MAX_LIMIT} (default from SHOPWARE_MCP_DEFAULT_LIMIT)`),
  fields: z
    .array(z.string().min(1))
    .max(30)
    .optional()
    .describe(
      "Extra raw entity fields to add to each item, e.g. ['customFields', 'ean']. Dot-paths allowed.",
    ),
};

export type SearchInput = z.output<z.ZodObject<typeof searchInputShape>>;

/* ------------------------------------------------------------------------------------------
 * Shopware Criteria JSON
 * ---------------------------------------------------------------------------------------- */

export type ShopwareFilter =
  | {
      type: "equals" | "contains" | "equalsAny" | "prefix" | "suffix";
      field: string;
      value: unknown;
    }
  | { type: "range"; field: string; parameters: Record<string, unknown> }
  | { type: "not"; operator: "and" | "or"; queries: ShopwareFilter[] }
  | { type: "multi"; operator: "and" | "or"; queries: ShopwareFilter[] };

export interface ShopwareSort {
  field: string;
  order: "ASC" | "DESC";
  naturalSorting?: boolean;
}

export type Associations = Record<string, Record<string, unknown>>;

export interface Criteria {
  page?: number;
  limit?: number;
  term?: string;
  filter?: ShopwareFilter[];
  sort?: ShopwareSort[];
  associations?: Associations;
  includes?: Record<string, string[]>;
  aggregations?: Record<string, unknown>[];
  "total-count-mode"?: 0 | 1 | 2;
}

export function toShopwareFilter(filter: Filter): ShopwareFilter {
  if (filter.type === "range") {
    const value = filter.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["filter", "value"],
          message: "range filter requires an object like { gte?, gt?, lte?, lt? }",
          input: value,
        },
      ]);
    }
    return { type: "range", field: filter.field, parameters: value };
  }
  return { type: filter.type, field: filter.field, value: filter.value };
}

/** Build association objects from dot-paths, e.g. ["cover.media", "children.options.group"]. */
export function associations(paths: string[]): Associations {
  const root: Associations = {};
  for (const path of paths) {
    let node: Record<string, unknown> = root;
    for (const segment of path.split(".")) {
      if (!node[segment]) node[segment] = {};
      const next = node[segment] as Record<string, unknown>;
      if (!next.associations) next.associations = {};
      node = next.associations as Record<string, unknown>;
    }
  }
  return stripEmptyAssociations(root) as Associations;
}

function stripEmptyAssociations(node: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "object" || value === null) continue;
    const child = value as Record<string, unknown>;
    if ("associations" in child) {
      const inner = child.associations as Record<string, unknown>;
      if (Object.keys(inner).length === 0) delete child.associations;
      else stripEmptyAssociations(inner);
    }
    node[key] = child;
  }
  return node;
}

export function resolveLimit(limit: number | undefined, defaultLimit: number): number {
  const wanted = limit ?? defaultLimit;
  return Math.max(1, Math.min(wanted, MAX_LIMIT));
}

export interface BuildCriteriaOptions {
  defaultLimit: number;
  /** Applied when the caller passed neither `sort` nor `term`. */
  defaultSort?: ShopwareSort[];
  /** Filters always applied (AND) in addition to the caller's. */
  extraFilters?: ShopwareFilter[];
  associations?: Associations;
  aggregations?: Record<string, unknown>[];
}

export function buildCriteria(input: SearchInput, options: BuildCriteriaOptions): Criteria {
  const criteria: Criteria = {
    page: input.page ?? 1,
    limit: resolveLimit(input.limit, options.defaultLimit),
    "total-count-mode": 1,
  };
  if (input.term) criteria.term = input.term;

  const filters = [...(options.extraFilters ?? []), ...(input.filter ?? []).map(toShopwareFilter)];
  if (filters.length > 0) criteria.filter = filters;

  if (input.sort && input.sort.length > 0) {
    criteria.sort = input.sort.map((sort) => ({ field: sort.field, order: sort.order }));
  } else if (!input.term && options.defaultSort) {
    criteria.sort = options.defaultSort;
  }

  if (options.associations && Object.keys(options.associations).length > 0) {
    criteria.associations = options.associations;
  }
  if (options.aggregations && options.aggregations.length > 0) {
    criteria.aggregations = options.aggregations;
  }
  return criteria;
}

export const equals = (field: string, value: unknown): ShopwareFilter => ({
  type: "equals",
  field,
  value,
});

export const equalsAny = (field: string, value: unknown[]): ShopwareFilter => ({
  type: "equalsAny",
  field,
  value,
});
