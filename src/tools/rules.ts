import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ShopwareFilter } from "../client/criteria.js";
import { INHERITANCE_HEADERS, type Raw, type ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { str, translated } from "./shared.js";

/**
 * A shop's own audit rule, without code: "records of this entity that match this filter are a
 * problem". The filter is plain Shopware criteria, the same JSON the Admin API takes.
 */
export const auditRuleSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_]{1,60}$/, "id: lower-case letters, digits and _ only")
    .describe("Short id, e.g. 'products_without_manufacturer'"),
  title: z.string().trim().min(1).max(160).describe("What the finding says"),
  severity: z.enum(["critical", "warning", "info"]).default("warning"),
  entity: z
    .string()
    .regex(/^[a-z][a-z_-]{1,60}$/, "entity: a Shopware entity name like product or order")
    .transform((value) => value.replace(/_/g, "-"))
    .describe("Entity to search, e.g. product, order, customer"),
  filter: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(20)
    .describe("Shopware criteria filters; matching records are findings"),
  hint: z.string().trim().max(400).default("").describe("What to do about it"),
});

export type AuditRule = z.input<typeof auditRuleSchema>;
type ParsedRule = z.output<typeof auditRuleSchema>;

/** Rules from a JSON file: an array, or an object with a `rules` array. */
export function loadRules(file: string): AuditRule[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw badRequest(
      `Cannot read audit rules from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const list = Array.isArray(value) ? value : (value as { rules?: unknown })?.rules;
  const parsed = z.array(auditRuleSchema).min(1).max(50).safeParse(list);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(
      `Invalid audit rules in ${file}: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown"}`,
    );
  }
  const ids = parsed.data.map((rule) => rule.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) throw badRequest(`Invalid audit rules in ${file}: id ${twice} appears twice`);
  return list as AuditRule[];
}

/** The rules named by SHOPWARE_MCP_RULES, or none. */
export function rulesFromEnv(env: NodeJS.ProcessEnv = process.env): AuditRule[] {
  const file = env.SHOPWARE_MCP_RULES?.trim();
  return file ? loadRules(file) : [];
}

/** A record as a short line: its number or name, whatever the entity has. */
function describe(record: Raw): Record<string, unknown> {
  const label =
    str(record.productNumber) ??
    str(record.orderNumber) ??
    str(record.customerNumber) ??
    translated(record, "name") ??
    str(record.email) ??
    str(record.technicalName) ??
    str(record.code);
  return { id: str(record.id), ...(label ? { label } : {}) };
}

export function parseRule(rule: AuditRule): ParsedRule {
  return auditRuleSchema.parse(rule);
}

/** Count and sample the records a rule matches. */
export async function runRule(client: ShopwareClient, rule: ParsedRule, limit: number) {
  const result = await client.search<Raw>(
    rule.entity,
    {
      page: 1,
      limit,
      "total-count-mode": 1,
      filter: rule.filter as unknown as ShopwareFilter[],
    },
    rule.entity === "product" ? INHERITANCE_HEADERS : undefined,
  );
  return { count: result.total, items: result.items.map(describe) };
}
