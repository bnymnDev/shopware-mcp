import { z } from "zod";
import { equals, type ShopwareFilter } from "../client/criteria.js";
import { badRequest } from "../errors.js";
import { round2 } from "./aggregations.js";

/** Date handling shared by the report tools. */

export const DAY_MS = 86_400_000;

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use an ISO date like 2026-08-01");

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A date without a time means the whole day: its start for `from`, its last millisecond for `to`.
 * A time without an offset is read as UTC, like a bare date, rather than as the server's zone.
 */
export function toIso(value: string | undefined, fallback: Date, endOfDay = false): string {
  if (!value) return fallback.toISOString();
  const normalized = value.includes("T") && !HAS_OFFSET.test(value) ? `${value}Z` : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`Invalid date: ${value}`);
  if (endOfDay && DATE_ONLY.test(value)) parsed.setUTCHours(23, 59, 59, 999);
  return parsed.toISOString();
}

export interface Period {
  from: string;
  to: string;
}

/** Resolve `from`/`to` with defaults (last `defaultDays` days up to now) and validate the order. */
export function resolvePeriod(
  input: { from?: string; to?: string },
  defaultDays: number,
  now = new Date(),
): Period {
  const from = toIso(input.from, new Date(now.getTime() - defaultDays * DAY_MS));
  const to = toIso(input.to, now, true);
  if (from > to) throw badRequest("`from` must be before `to`");
  return { from, to };
}

/** The period of equal length that ends right before `period.from`. */
export function previousPeriod(period: Period): Period {
  const to = new Date(Date.parse(period.from) - 1);
  const from = new Date(to.getTime() - (Date.parse(period.to) - Date.parse(period.from)));
  return { from: from.toISOString(), to: to.toISOString() };
}

export function change(current: number, previous: number) {
  return {
    absolute: round2(current - previous),
    percent: previous === 0 ? null : round2(((current - previous) / previous) * 100),
  };
}

export function notCancelled(prefix = ""): ShopwareFilter {
  return {
    type: "not",
    operator: "and",
    queries: [equals(`${prefix}stateMachineState.technicalName`, "cancelled")],
  };
}

export const dateRange = (field: string, period: Period): ShopwareFilter => ({
  type: "range",
  field,
  parameters: { gte: period.from, lte: period.to },
});
