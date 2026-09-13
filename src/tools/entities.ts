import { z } from "zod";
import { associations, buildCriteria, searchInputShape } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../logger.js";
import { boundText, isRaw, raw, str, strList } from "./shared.js";
import { defineTool } from "./types.js";

/** Entities that hold credentials, ACLs or system internals and are never exposed. */
const BLOCKED_ENTITIES = new Set([
  "user",
  "user_access_key",
  "user_recovery",
  "user_config",
  "integration",
  "integration_role",
  "acl_role",
  "acl_user_role",
  "app",
  "app_payment_method",
  "system_config",
  "customer_recovery",
  "customer_wishlist",
  "webhook",
  "webhook_event_log",
  "sales_channel_api_context",
  "dead_message",
  "message_queue_stats",
  "import_export_log",
  "import_export_file",
  "notification",
  "log_entry",
  "version",
  "version_commit",
  "version_commit_data",
]);

const SENSITIVE_KEY =
  /password|secret|token|accesskey|apikey|privatekey|credential|deeplinkcode|hash$|^salt$/i;
const NOISE_KEYS = new Set(["_uniqueIdentifier", "versionId", "extensions", "apiAlias"]);
const MAX_DEPTH = 8;

/** Remove credentials and internal noise from any entity payload, recursively. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (!isRaw(value)) return boundText(value);
  const out: Raw = {};
  for (const [key, inner] of Object.entries(value)) {
    if (NOISE_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
    out[key] = scrub(inner, depth + 1);
  }
  return out;
}

const ENTITY_NAME = /^[a-z][a-z0-9_-]{1,80}$/;

export function normalizeEntity(input: string): { snake: string; kebab: string } {
  const trimmed = input.trim().toLowerCase();
  if (!ENTITY_NAME.test(trimmed)) throw badRequest(`Invalid entity name: ${input}`);
  const snake = trimmed.replace(/-/g, "_");
  if (BLOCKED_ENTITIES.has(snake)) {
    throw badRequest(
      `Entity "${snake}" is not exposed because it holds credentials or system internals`,
    );
  }
  return { snake, kebab: snake.replace(/_/g, "-") };
}

const aggregationLeaf = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, "letters, digits and _ only")
    .describe("Key of the result"),
  type: z.enum(["terms", "sum", "avg", "min", "max", "count", "stats", "histogram"]),
  field: z.string().min(1).max(200).describe("Entity field; dot-paths for associations"),
  limit: z.number().int().min(1).max(500).optional().describe("terms: max buckets"),
  sort: z
    .object({ field: z.string().min(1), order: z.enum(["ASC", "DESC"]).default("DESC") })
    .optional()
    .describe("terms: bucket order, e.g. { field: '_count', order: 'DESC' }"),
  interval: z
    .enum(["minute", "hour", "day", "week", "month", "quarter", "year"])
    .optional()
    .describe("histogram: bucket size"),
});

const aggregationSchema = aggregationLeaf
  .extend({
    aggregation: aggregationLeaf
      .optional()
      .describe("One nested metric per bucket, e.g. a sum inside a terms aggregation"),
  })
  .refine((aggregation) => aggregation.type !== "histogram" || aggregation.interval, {
    message: "A histogram needs an interval",
  });

/**
 * A dot-path may hop through associations into an entity that is blocked (`order.createdBy`
 * reaches `user`), and a filter, sort or aggregation on it would read what entity_search
 * refuses to return. Every hop is resolved against the shop's schema; a credential-like
 * segment is refused regardless. Without a schema only the name check applies.
 */
async function assertPathAllowed(
  client: ShopwareClient,
  entity: string,
  path: string,
): Promise<void> {
  const segments = path.split(".");
  for (const segment of segments) {
    if (SENSITIVE_KEY.test(segment)) throw badRequest(`Field "${path}" is not exposed`);
  }
  let schema: Record<string, Raw>;
  try {
    schema = await client.entitySchema();
  } catch (error) {
    logger.warn("entity schema unavailable, association paths are not checked", {
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  let current = entity;
  for (const segment of segments) {
    const property = raw(raw(raw(schema[current])?.properties)?.[segment]);
    if (property?.type !== "association") return;
    const target = str(property.entity);
    if (!target) return;
    if (BLOCKED_ENTITIES.has(target)) {
      throw badRequest(`Field "${path}" reaches "${target}", which is not exposed`);
    }
    current = target;
  }
}

export const entitySearch = defineTool({
  name: "entity_search",
  title: "Search any entity",
  description:
    "Escape hatch for everything without a dedicated tool: search ANY Shopware entity " +
    "(e.g. product_manufacturer, property_group, shipping_method, tax, country, newsletter_recipient, " +
    "product_review, seo_url, cms_page, media) with the same Criteria filters, sort and paging. " +
    "Use entity_schema first to see the available fields and associations. Credentials and " +
    "internal fields are always stripped, long values such as stored files are truncated, and " +
    "entities holding secrets (users, integrations, system config) are blocked. Prefer the " +
    "dedicated tools when one exists. `aggregations` asks Shopware to count, sum or average " +
    "over the whole match (terms, sum, avg, min, max, count, stats, histogram, one nested " +
    "metric per bucket), e.g. orders per payment method or revenue per month for any entity; " +
    "set limit: 1 when only the aggregations matter. " +
    "Returns { entity, total, page, limit, items[], aggregations? } with raw (scrubbed) data.",
  inputSchema: {
    entity: z
      .string()
      .min(2)
      .describe("Entity name in snake_case or kebab-case, e.g. 'product_manufacturer'"),
    term: searchInputShape.term,
    filter: searchInputShape.filter,
    sort: searchInputShape.sort,
    page: searchInputShape.page,
    limit: searchInputShape.limit,
    fields: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Only return these fields of the entity (Shopware `includes`)"),
    associations: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe("Association names to load, e.g. ['country', 'salesChannels']"),
    aggregations: z
      .array(aggregationSchema)
      .max(10)
      .optional()
      .describe("Shopware aggregations computed over the whole match"),
  },
  handler: async (input, ctx) => {
    const { snake, kebab } = normalizeEntity(input.entity);
    const paths = [
      ...(input.filter ?? []).map((filter) => filter.field),
      ...(input.sort ?? []).map((sort) => sort.field),
      ...(input.associations ?? []),
      ...(input.aggregations ?? []).flatMap((aggregation) => [
        aggregation.field,
        ...(aggregation.aggregation ? [aggregation.aggregation.field] : []),
      ]),
    ];
    for (const path of paths) await assertPathAllowed(ctx.client, snake, path);
    const criteria = buildCriteria(
      {
        term: input.term,
        filter: input.filter,
        sort: input.sort,
        page: input.page,
        limit: input.limit,
      },
      { defaultLimit: ctx.config.defaultLimit },
    );
    if (input.fields && input.fields.length > 0) {
      criteria.includes = { [snake]: [...new Set(["id", ...input.fields])] };
    }
    if (input.associations && input.associations.length > 0) {
      criteria.associations = associations(input.associations);
    }
    if (input.aggregations && input.aggregations.length > 0) {
      criteria.aggregations = input.aggregations;
    }
    const result = await ctx.client.search<Raw>(kebab, criteria);
    return {
      entity: snake,
      total: result.total,
      page: criteria.page ?? 1,
      limit: criteria.limit ?? result.items.length,
      items: result.items.map((item) => scrub(item)),
      ...(criteria.aggregations ? { aggregations: scrub(result.aggregations) } : {}),
    };
  },
});

interface FieldInfo {
  name: string;
  type: string;
  flags: string[];
}

interface AssociationInfo {
  name: string;
  relation: string | null;
  entity: string | null;
}

function describeEntity(name: string, definition: Raw) {
  const fields: FieldInfo[] = [];
  const associationList: AssociationInfo[] = [];
  const properties = raw(definition.properties) ?? {};
  for (const [fieldName, spec] of Object.entries(properties)) {
    const property = raw(spec);
    if (!property) continue;
    const type = str(property.type) ?? "unknown";
    const flagsRaw = property.flags;
    const flags = isRaw(flagsRaw) ? Object.keys(flagsRaw) : strList(flagsRaw);
    if (type === "association") {
      associationList.push({
        name: fieldName,
        relation: str(property.relation),
        entity: str(property.entity),
      });
    } else if (!SENSITIVE_KEY.test(fieldName)) {
      fields.push({ name: fieldName, type, flags });
    }
  }
  return { entity: name, fields, associations: associationList };
}

export const entitySchema = defineTool({
  name: "entity_schema",
  title: "Entity schema",
  description:
    "Describe a Shopware entity: its fields (name, type, flags such as required/translatable) " +
    "and associations (name, relation, target entity), taken from the shop's own entity schema. " +
    "Call it without `entity` to list all entity names. Use it to build precise filters for " +
    "entity_search or the `fields` parameter of other tools. Returns one object.",
  inputSchema: {
    entity: z.string().min(2).optional().describe("Entity name; omit to list all entities"),
  },
  handler: async (input, ctx) => {
    const schema = await ctx.client.entitySchema();
    if (!input.entity) {
      const entities = Object.keys(schema)
        .filter((name) => !BLOCKED_ENTITIES.has(name))
        .sort();
      return { total: entities.length, entities };
    }
    const { snake } = normalizeEntity(input.entity);
    const definition = raw(schema[snake]);
    if (!definition) throw notFound("entity", snake);
    return describeEntity(snake, definition);
  },
});
