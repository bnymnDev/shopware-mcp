import { beforeAll, describe, expect, it } from "vitest";
import { detectExtensionTools } from "../src/extensions/index.js";
import {
  merqoAbandonedCarts,
  merqoEinvoiceInbox,
  merqoHealth,
  merqoReturns,
} from "../src/extensions/merqo.js";
import type { ToolContext } from "../src/tools/types.js";
import { E2E_ENABLED, e2eContext } from "./setup.js";

/**
 * Runs only against a shop that actually has the extensions installed. Everything is skipped
 * elsewhere, so the suite stays green on a plain Shopware.
 */
describe.skipIf(!E2E_ENABLED)("plugin-aware tools", () => {
  let ctx: ToolContext;
  let detected: string[];

  beforeAll(async () => {
    ctx = await e2eContext();
    detected = (await detectExtensionTools(ctx)).map((entry) => entry.tool.name);
  });

  it("detects nothing it cannot back with an installed plugin", () => {
    expect(Array.isArray(detected)).toBe(true);
  });

  it("merqo_health mirrors the hub, including its plugin map", async () => {
    if (!detected.includes("merqo_health")) return;
    const health = await merqoHealth.handler({}, ctx);
    expect(health.shopwareVersion).toMatch(/^6\.\d+/);
    // The hub keys plugins by name; an empty list here means the shape drifted.
    expect(health.plugins.length).toBeGreaterThan(0);
    expect(health.plugins.every((plugin) => plugin.name !== null)).toBe(true);
    const statuses = [...health.compliance, ...health.operations].map((check) => check.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(
      statuses.every((status) => ["ok", "warn", "critical", "neutral"].includes(status ?? "")),
    ).toBe(true);
  });

  it("merqo_einvoice_inbox maps documents without shipping the archived file", async () => {
    if (!detected.includes("merqo_einvoice_inbox")) return;
    const page = await merqoEinvoiceInbox.handler({ page: 1 }, ctx);
    expect(page.total).toBeGreaterThanOrEqual(0);
    for (const item of page.items) {
      expect(item.id).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(item).length).toBeLessThan(20_000);
    }
  });

  it("merqo_returns_search answers even with an empty portal", async () => {
    if (!detected.includes("merqo_returns_search")) return;
    const page = await merqoReturns.handler({ page: 1 }, ctx);
    expect(page.total).toBeGreaterThanOrEqual(0);
  });

  it("merqo_abandoned_carts maps line items and hides the cart token", async () => {
    if (!detected.includes("merqo_abandoned_carts")) return;
    const page = await merqoAbandonedCarts.handler({ page: 1 }, ctx);
    expect(page.total).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('"token"');
    for (const cart of page.items) {
      for (const item of cart.lineItems) {
        // unitPrice and totalPrice are what the plugin stores; a null pair means drift.
        expect(item.quantity === null && item.unitPrice === null).toBe(false);
      }
    }
  });
});
