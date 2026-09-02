import { z } from "zod";
import { DEFAULT_CURRENCY_ID, UUID_PATTERN } from "../client/constants.js";
import type { CurrencyInfo, Raw, SearchResult } from "../client/index.js";

export const idSchema = z
  .string()
  .regex(UUID_PATTERN, "Expected a 32-character hex Shopware UUID")
  .transform((value) => value.toLowerCase());

export const dryRunField = z
  .boolean()
  .default(true)
  .describe("true (default): return the request that would be sent without writing anything");

export function isRaw(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const raw = (value: unknown): Raw | null => (isRaw(value) ? value : null);
export const rawList = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRaw) : []);
export const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
export const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Resolve a translatable field: `translated.<field>` first, then the raw field. */
export function translated(entity: Raw | null | undefined, field: string): string | null {
  if (!entity) return null;
  const translations = raw(entity.translated);
  const value = translations?.[field];
  if (typeof value === "string") return value;
  return str(entity[field]);
}

export function getPath(target: unknown, path: string): unknown {
  let current: unknown = target;
  for (const segment of path.split(".")) {
    if (!isRaw(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Copy requested raw fields (dot-paths allowed) from the entity onto the mapped item. */
export function withFields<T extends object>(mapped: T, entity: Raw, fields?: string[]): T {
  if (!fields || fields.length === 0) return mapped;
  const extras: Raw = {};
  for (const field of fields) {
    const value = getPath(entity, field);
    extras[field] = value === undefined ? null : value;
  }
  return { ...mapped, ...extras };
}

export interface PriceView {
  gross: number | null;
  net: number | null;
  currency: string | null;
  currencyId: string | null;
  listPriceGross: number | null;
}

/** Pick the price entry for the default currency (or the first one) from a product-like entity. */
export function pickPrice(
  entity: Raw,
  currencies: Map<string, CurrencyInfo> | null,
  preferredCurrencyId: string = DEFAULT_CURRENCY_ID,
): PriceView | null {
  const prices = rawList(entity.price);
  if (prices.length === 0) return null;
  const entry = prices.find((price) => price.currencyId === preferredCurrencyId) ?? prices[0];
  if (!entry) return null;
  const currencyId = str(entry.currencyId);
  return {
    gross: num(entry.gross),
    net: num(entry.net),
    currency: currencyId ? (currencies?.get(currencyId)?.isoCode ?? null) : null,
    currencyId,
    listPriceGross: num(raw(entry.listPrice)?.gross),
  };
}

export interface Page<T> {
  total: number;
  page: number;
  limit: number;
  items: T[];
}

export function toPage<T>(
  result: SearchResult<Raw>,
  criteria: { page?: number; limit?: number },
  mapItem: (entity: Raw) => T,
): Page<T> {
  return {
    total: result.total,
    page: criteria.page ?? 1,
    limit: criteria.limit ?? result.items.length,
    items: result.items.map(mapItem),
  };
}

export const technicalState = (state: unknown): string | null => str(raw(state)?.technicalName);

export function fullName(entity: Raw | null | undefined): string | null {
  if (!entity) return null;
  const parts = [str(entity.firstName), str(entity.lastName)].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function sortByKey<T extends Raw>(items: T[], key: string): T[] {
  return [...items].sort((left, right) => {
    const a = left[key];
    const b = right[key];
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a ?? "").localeCompare(String(b ?? ""));
  });
}
