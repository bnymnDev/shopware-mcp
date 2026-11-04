import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildBrief } from "../src/brief.js";
import type { Raw } from "../src/client/index.js";
import { diagnose } from "../src/diagnose.js";
import { runAudit } from "../src/tools/audit.js";
import { agentReadiness } from "../src/tools/feed.js";
import { runJourneys } from "../src/tools/journeys.js";
import { checkMargins, promotionImpact } from "../src/tools/margins.js";
import type { ToolContext } from "../src/tools/types.js";
import { updateCheck } from "../src/tools/updates.js";
import { shopBrief, VIEW_DATA } from "../src/views.js";
import { E2E_ENABLED, e2eContext } from "./setup.js";

describe.skipIf(!E2E_ENABLED)("journeys, diagnosis, margins and the brief against dockware", () => {
  let ctx: ToolContext;
  let productNumber: string;

  beforeAll(async () => {
    ctx = await e2eContext(true);
    const products = await ctx.client.search<Raw>("product", {
      page: 1,
      limit: 1,
      filter: [
        { type: "equals", field: "active", value: true },
        { type: "equals", field: "childCount", value: 0 },
        { type: "range", field: "availableStock", parameters: { gt: 2 } },
      ],
      includes: { product: ["productNumber"] },
    });
    productNumber = String(products.items[0]?.productNumber ?? "");
    expect(productNumber).not.toBe("");
  });

  it("journeys_run passes a working path and names a broken one", async () => {
    const result = await runJourneys(ctx, [
      { name: "buys one", items: [{ productNumber }] },
      {
        name: "wants a method that is not there",
        items: [{ productNumber }],
        expect: { paymentMethods: ["No such method"] },
      },
      { name: "unknown product", items: [{ productNumber: "E2E-NOT-THERE" }] },
    ]);
    expect(result.results[0]).toMatchObject({ name: "buys one", ok: true });
    expect(result.results[1]?.failures[0]).toMatch(/^No such method is not offered \(offered: /);
    expect(result.results[2]?.ok).toBe(false);
    expect(result).toMatchObject({ passed: 1, failed: 2 });
  });

  it("shop_diagnose looks at every suspect without failing", async () => {
    const result = await diagnose(ctx);
    expect(result.causes.length + result.fine.length).toBeGreaterThan(0);
    for (const line of [...result.causes, ...result.fine]) expect(typeof line).toBe("string");
  });

  it("promotion_impact and margin_check read real orders and prices", async () => {
    const impact = await promotionImpact(ctx.client, {
      discount: { type: "percentage", value: 10 },
      days: 365,
    });
    expect(impact.orders).toBeGreaterThanOrEqual(0);
    expect(impact.scenarios.everyEligibleOrder.cost).toBeGreaterThanOrEqual(0);
    const margins = await checkMargins(ctx.client, { minMargin: 15, maxItems: 5 });
    expect(margins.checked).toBeGreaterThan(0);
    expect(margins.summary.belowCost).toBeGreaterThanOrEqual(margins.belowCost.length);
  });

  it("the shop's own rules run as Shopware criteria", async () => {
    const report = await runAudit(ctx.client, {
      stuckOrderDays: 7,
      lowStockThreshold: 5,
      forecastDays: 14,
      maxItems: 2,
      complianceChecks: false,
      timeZone: "Europe/Berlin",
      rules: [
        {
          id: "active_products",
          title: "Active products",
          severity: "info",
          entity: "product",
          filter: [{ type: "equals", field: "active", value: true }],
        },
      ],
    });
    expect(report.warnings ?? []).not.toContainEqual(expect.stringMatching(/^active_products/));
    expect(report.findings.find((finding) => finding.id === "active_products")).toMatchObject({
      custom: true,
      count: expect.any(Number),
    });
  });

  it("brief --history keeps a score per day", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "swmcp-e2e-")), "health.json");
    const brief = await buildBrief(ctx.client, { timeZone: "Europe/Berlin", history: file });
    expect(brief.trend?.days).toHaveLength(1);
    expect(brief.trend?.today.score).toBeGreaterThanOrEqual(0);
  });

  it("agent_readiness builds a feed row for every visible product", async () => {
    const result = await agentReadiness(ctx.client, { maxItems: 2 });
    expect(result.products.checked).toBeGreaterThan(0);
    expect(result.feedSample[0]).toMatchObject({
      item_id: expect.any(String),
      price: expect.stringMatching(/^\d+\.\d{2} [A-Z]{3}$/),
      availability: expect.stringMatching(/^(in_stock|out_of_stock|backorder)$/),
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("update_check reads the current version and says what it could not check", async () => {
    const result = await updateCheck(ctx.client);
    expect(result.currentVersion).toMatch(/^6\.\d+\.\d+/);
    expect(Array.isArray(result.notes)).toBe(true);
  });

  it("shop_brief keeps the whole brief for its page and a summary for the model", async () => {
    const result = await shopBrief.handler({ timeZone: "Europe/Berlin" }, ctx);
    expect(result.headline.text).toEqual(expect.any(String));
    expect(result[VIEW_DATA]?.pulse).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("history");
  });
});
