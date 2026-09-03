import type { Raw } from "../client/index.js";
import { num, raw, rawList, str } from "./shared.js";

/** Helpers for the JSON shape Shopware uses for aggregation results. */

export interface Bucket {
  key: string | null;
  count: number;
  /** Result of the nested aggregation, if the terms/histogram aggregation had one. */
  nested: Raw | null;
}

export function bucketsOf(aggregations: Record<string, unknown>, name: string): Bucket[] {
  return rawList(raw(aggregations[name])?.buckets).map((bucket) => ({
    key: str(bucket.key) ?? (bucket.key === null ? null : String(bucket.key)),
    count: num(bucket.count) ?? 0,
    nested: raw(bucket.result) ?? nestedByName(bucket),
  }));
}

/** Older Shopware versions serialize the nested result under the nested aggregation's name. */
function nestedByName(bucket: Raw): Raw | null {
  for (const [key, value] of Object.entries(bucket)) {
    if (["key", "count", "apiAlias", "extensions"].includes(key)) continue;
    const candidate = raw(value);
    if (candidate) return candidate;
  }
  return null;
}

export const sumOf = (value: unknown): number => num(raw(value)?.sum) ?? 0;
export const avgOf = (value: unknown): number | null => num(raw(value)?.avg);
export const countOf = (value: unknown): number => num(raw(value)?.count) ?? 0;

export const round2 = (value: number): number => Math.round(value * 100) / 100;
