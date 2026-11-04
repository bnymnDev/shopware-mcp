import { readFileSync } from "node:fs";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { checkoutSimulate } from "./storefront.js";
import type { ToolContext } from "./types.js";
import { defineTool } from "./types.js";

/** What a journey must find for the shop to count as working. */
const expectSchema = z
  .object({
    canOrder: z.boolean().default(true).describe("The cart can be ordered (default true)"),
    paymentMethods: z
      .array(z.string().min(1))
      .optional()
      .describe("Payment methods that must be offered, by name, e.g. ['PayPal']"),
    shippingMethods: z
      .array(z.string().min(1))
      .optional()
      .describe("Shipping methods that must be offered"),
    promotionsApplied: z
      .boolean()
      .optional()
      .describe(
        "Every promotion code of the journey must apply (default: true when codes are given)",
      ),
    minTotal: z.number().optional().describe("The total must be at least this"),
    maxTotal: z.number().optional().describe("The total must be at most this"),
  })
  .default({ canOrder: true });

const simulateShape = checkoutSimulate.inputSchema;

export const journeySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("What this path stands for, e.g. 'Swiss guest with code'"),
  ...simulateShape,
  expect: expectSchema,
});

export type Journey = z.input<typeof journeySchema>;

export interface JourneyResult {
  name: string;
  ok: boolean;
  failures: string[];
  total: number | null;
  canOrder: boolean;
}

const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/**
 * Run each journey through the real cart, one after the other, and say in plain words which
 * expectation broke. A journey that cannot even start (unknown product, channel) fails too:
 * the path a customer would take no longer exists.
 */
export async function runJourneys(
  ctx: ToolContext,
  journeys: Journey[],
): Promise<{
  ok: boolean;
  passed: number;
  failed: number;
  results: JourneyResult[];
}> {
  const results: JourneyResult[] = [];
  for (const entry of journeys) {
    const journey = journeySchema.parse(entry);
    const { name, expect, ...input } = journey;
    const failures: string[] = [];
    let total: number | null = null;
    let canOrder = false;
    try {
      const result = await checkoutSimulate.handler(input, ctx);
      canOrder = result.canOrder;
      total = result.totals?.total ?? null;
      const blocking = result.problems.filter((problem) => problem.blocksOrder);
      if (expect.canOrder && !result.canOrder) {
        for (const problem of blocking) {
          failures.push(`cannot order: ${problem.explanation ?? problem.message ?? problem.key}`);
        }
        if (blocking.length === 0) failures.push("cannot order");
      }
      if (!expect.canOrder && result.canOrder) failures.push("can order, though it should not");
      const offered = result.paymentMethods?.available ?? [];
      for (const method of expect.paymentMethods ?? []) {
        if (!offered.some((name) => same(name, method))) {
          const hidden = result.paymentMethods?.hidden.find((entry) => same(entry.name, method));
          failures.push(
            `${method} is not offered${hidden ? `: ${hidden.reason}` : ""} (offered: ${offered.join(", ") || "none"})`,
          );
        }
      }
      const shipping = result.shippingMethods?.available ?? [];
      for (const method of expect.shippingMethods ?? []) {
        if (!shipping.some((name) => same(name, method))) {
          failures.push(
            `${method} is not offered for shipping (offered: ${shipping.join(", ") || "none"})`,
          );
        }
      }
      const codes = input.promotionCodes ?? [];
      if ((expect.promotionsApplied ?? codes.length > 0) && codes.length > 0) {
        for (const code of codes) {
          if (result.promotions.some((promotion) => same(promotion.code, code))) continue;
          const why = result.problems.find(
            (problem) =>
              problem.key.startsWith("promotion") &&
              (problem.message?.includes(code) || problem.explanation?.includes(code)),
          );
          failures.push(
            `code ${code} does not apply${why?.explanation ? `: ${why.explanation}` : ""}`,
          );
        }
      }
      if (expect.minTotal !== undefined && total !== null && total < expect.minTotal) {
        failures.push(`total ${total} is below ${expect.minTotal}`);
      }
      if (expect.maxTotal !== undefined && total !== null && total > expect.maxTotal) {
        failures.push(`total ${total} is above ${expect.maxTotal}`);
      }
    } catch (error) {
      failures.push(`could not run: ${error instanceof Error ? error.message : String(error)}`);
    }
    results.push({ name, ok: failures.length === 0, failures, total, canOrder });
  }
  const failed = results.filter((result) => !result.ok).length;
  return { ok: failed === 0, passed: results.length - failed, failed, results };
}

/** Journeys from a JSON file: an array, or an object with a `journeys` array. */
export function loadJourneys(file: string): Journey[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw badRequest(
      `Cannot read journeys from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const list = Array.isArray(value) ? value : (value as { journeys?: unknown })?.journeys;
  const parsed = z.array(journeySchema).min(1).max(20).safeParse(list);
  if (!parsed.success) {
    throw badRequest(
      `Invalid journeys in ${file}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return list as Journey[];
}

export const journeysRun = defineTool({
  name: "journeys_run",
  title: "Run customer journeys",
  description:
    "Synthetic customers: run fixed buying paths through the shop's real cart, e.g. 'Swiss " +
    "guest with code SUMMER26', 'regular customer pays by invoice', and say which one broke " +
    "and why. Each journey takes the inputs of checkout_simulate plus expectations: the cart " +
    "can be ordered, given payment or shipping methods are offered, codes apply, the total " +
    "stays in a range. Without journeys it runs the ones in SHOPWARE_MCP_JOURNEYS (a JSON file). " +
    "Nothing is ordered; carts are deleted. Returns { ok, passed, failed, results[] }.",
  annotations: { idempotentHint: false },
  inputSchema: {
    journeys: z.array(journeySchema).min(1).max(20).optional().describe("Journeys to run"),
  },
  handler: async (input, ctx) => {
    const file = process.env.SHOPWARE_MCP_JOURNEYS;
    const journeys = input.journeys ?? (file ? loadJourneys(file) : null);
    if (!journeys) {
      throw badRequest("Pass journeys, or set SHOPWARE_MCP_JOURNEYS to a JSON file with them");
    }
    return runJourneys(ctx, journeys);
  },
});
