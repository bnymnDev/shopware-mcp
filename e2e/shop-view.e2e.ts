import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Raw } from "../src/client/index.js";
import { ShopwareClient } from "../src/client/index.js";
import { runDoctor } from "../src/doctor.js";
import { AdminSession, applySetup, planSetup, type SetupOptions } from "../src/setup.js";
import { computePulse } from "../src/tools/pulse.js";
import { checkoutSimulate, resolveChannel, storefrontSearch } from "../src/tools/storefront.js";
import type { ToolContext } from "../src/tools/types.js";
import { E2E_ENABLED, e2eContext } from "./setup.js";

const SHOP_URL = (process.env.SHOPWARE_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const suffix = () => Math.random().toString(36).slice(2, 8);

describe.skipIf(!E2E_ENABLED)("the shop as a customer sees it", () => {
  let ctx: ToolContext;
  let channelName: string;
  let channelId: string;
  let productNumber: string;
  let term: string;

  beforeAll(async () => {
    ctx = await e2eContext(false);
    // Pick an open channel: the shop may keep its storefront in maintenance on purpose.
    const channels = await ctx.client.search<Raw>("sales-channel", {
      page: 1,
      limit: 20,
      filter: [
        { type: "equals", field: "active", value: true },
        { type: "equals", field: "maintenance", value: false },
        {
          type: "not",
          operator: "and",
          queries: [{ type: "equals", field: "typeId", value: "ed535e5722134ac1aa6524f73e26881b" }],
        },
      ],
      includes: { sales_channel: ["id", "name"] },
    });
    const channel = channels.items[0];
    if (!channel) throw new Error("no open sales channel");
    channelId = String(channel.id);
    channelName = String(channel.name);
    const visible = await ctx.client.search<Raw>("product", {
      page: 1,
      limit: 1,
      filter: [
        { type: "equals", field: "active", value: true },
        { type: "equals", field: "visibilities.salesChannelId", value: channelId },
        { type: "range", field: "visibilities.visibility", parameters: { gte: 30 } },
        { type: "range", field: "availableStock", parameters: { gt: 2 } },
        { type: "equals", field: "childCount", value: 0 },
      ],
      includes: { product: ["productNumber", "name", "translated"] },
    });
    const product = visible.items[0];
    if (!product) throw new Error("no visible product in stock");
    productNumber = String(product.productNumber);
    const name = String((product.translated as Raw | undefined)?.name ?? product.name ?? "");
    term = name.split(/\s+/).find((word) => word.length >= 4) ?? name;
  });

  it("storefront_search finds a visible product and explains its position", async () => {
    const result = await storefrontSearch.handler(
      { term, salesChannel: channelName, limit: 5, explain: productNumber },
      ctx,
    );
    expect(result.total).toBeGreaterThan(0);
    expect(result.items[0]).toMatchObject({ position: 1, productNumber: expect.any(String) });
    expect(result.explain).toMatchObject({ productNumber });
    if (result.explain && !result.explain.found) {
      expect(result.explain.reasons.length).toBeGreaterThan(0);
    }
  });

  it("checkout_simulate prices a cart as a guest and deletes it", async () => {
    const code = `NOPE-${suffix()}`;
    const result = await checkoutSimulate.handler(
      {
        salesChannel: channelId,
        items: [{ productNumber, quantity: 1 }],
        promotionCodes: [code],
      },
      ctx,
    );
    expect(result).toMatchObject({
      salesChannel: { id: channelId },
      as: { guest: true },
      cartDeleted: true,
    });
    expect(result.items[0]).toMatchObject({ productNumber, quantity: 1 });
    expect(result.totals?.total).toBeGreaterThan(0);
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        key: "promotion-not-found",
        blocksOrder: false,
        explanation: `No promotion uses the code "${code}"`,
      }),
    );
    expect(result.paymentMethods?.available.length).toBeGreaterThan(0);
  });

  it("checkout_simulate explains a country the channel does not ship to", async () => {
    const channel = await resolveChannel(ctx.client, channelId);
    const assigned = await ctx.client.search<Raw>("country", {
      page: 1,
      limit: 300,
      filter: [{ type: "equals", field: "salesChannels.id", value: channelId }],
      includes: { country: ["iso"] },
    });
    const isos = new Set(assigned.items.map((country) => String(country.iso)));
    const outside = await ctx.client.search<Raw>("country", {
      page: 1,
      limit: 300,
      filter: [{ type: "equals", field: "active", value: true }],
      includes: { country: ["iso"] },
    });
    const foreign = outside.items
      .map((country) => String(country.iso))
      .find((iso) => !isos.has(iso));
    if (!foreign) return; // every active country is assigned; nothing to block
    const result = await checkoutSimulate.handler(
      { salesChannel: channel.id, items: [{ productNumber, quantity: 1 }], country: foreign },
      ctx,
    );
    expect(result.canOrder).toBe(false);
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        key: "shipping-address-blocked",
        blocksOrder: true,
        explanation: expect.stringContaining("is not among the countries of"),
      }),
    );
  });

  it("checkout_simulate logs in as a customer of the channel", async () => {
    const customers = await ctx.client.search<Raw>("customer", {
      page: 1,
      limit: 1,
      filter: [
        { type: "equals", field: "active", value: true },
        { type: "equals", field: "guest", value: false },
      ],
      includes: { customer: ["customerNumber"] },
    });
    const customerNumber = customers.items[0]?.customerNumber;
    if (typeof customerNumber !== "string") return;
    const result = await checkoutSimulate.handler(
      { salesChannel: channelId, items: [{ productNumber, quantity: 1 }], customerNumber },
      ctx,
    );
    expect(result).toMatchObject({ as: { customerNumber }, cartDeleted: true });
  });

  it("computes the pulse over real orders", async () => {
    const pulse = await computePulse(ctx.client, { weeks: 4, timeZone: "UTC" });
    expect(pulse.history).toHaveLength(5);
    expect(pulse.today.orders).toBeGreaterThanOrEqual(0);
    expect(["normal", "watch", "unusual"]).toContain(pulse.payments.verdict);
    if (pulse.lastOrder) {
      // Weeks whose stretch reaches into a long silence are left out.
      expect(pulse.silence?.sameGapInPreviousWeeks.length).toBeLessThanOrEqual(4);
    }
  });
});

describe.skipIf(!E2E_ENABLED)("setup against a real shop", () => {
  it("creates a least-privilege integration that runs the tools, then rotates it", async () => {
    const admin = await e2eContext(true);
    const session = await AdminSession.login(
      SHOP_URL,
      process.env.SHOPWARE_ADMIN_USER ?? "admin",
      process.env.SHOPWARE_ADMIN_PASS ?? "shopware",
    );
    const options: SetupOptions = {
      name: `shopware-mcp e2e ${suffix()}`,
      allowWrite: true,
      pluginUpdates: false,
      rotate: false,
    };
    const plan = await planSetup(session, options);
    const created = await applySetup(session, plan, options);
    // A code that exists but is assigned to no sales channel: only its explanation says why.
    const code = `E2E-NOCHANNEL-${suffix()}`.toUpperCase();
    const promotionId = randomUUID().replace(/-/g, "");
    await admin.client.request("/api/promotion", {
      method: "POST",
      body: {
        id: promotionId,
        name: `e2e ${code}`,
        active: true,
        useCodes: true,
        code,
        discounts: [{ scope: "cart", type: "percentage", value: 10, considerAdvancedRules: false }],
      },
    });
    try {
      expect(created.role.created).toBe(true);
      const keys = created.credentials;
      if (!keys) throw new Error("setup returned no credentials for a new integration");
      const config = { ...admin.config, clientId: keys.clientId, clientSecret: keys.clientSecret };
      const limited: ToolContext = { client: new ShopwareClient(config), config };
      const report = await runDoctor(limited, { label: options.name, privileges: plan.privileges });
      const blocked = report.tools.filter((item) => item.status !== "ready");
      // Everything but the settings tool, which needs the opt-in --settings.
      expect(blocked.map((item) => item.tool)).toEqual(["shop_settings"]);

      const channels = await admin.client.search<Raw>("sales-channel", {
        page: 1,
        limit: 1,
        filter: [
          { type: "equals", field: "active", value: true },
          { type: "equals", field: "maintenance", value: false },
          {
            type: "not",
            operator: "and",
            queries: [
              { type: "equals", field: "typeId", value: "ed535e5722134ac1aa6524f73e26881b" },
            ],
          },
        ],
        includes: { sales_channel: ["id"] },
      });
      const channelId = channels.items[0]?.id;
      const products = await admin.client.search<Raw>("product", {
        page: 1,
        limit: 1,
        filter: [
          { type: "equals", field: "active", value: true },
          { type: "equals", field: "childCount", value: 0 },
          { type: "equals", field: "visibilities.salesChannelId", value: channelId },
          { type: "range", field: "availableStock", parameters: { gt: 2 } },
        ],
        includes: { product: ["productNumber"] },
      });
      const productNumber = products.items[0]?.productNumber;
      if (typeof channelId !== "string" || typeof productNumber !== "string") {
        throw new Error("no open channel with a product in stock");
      }
      const result = await checkoutSimulate.handler(
        {
          salesChannel: channelId,
          items: [{ productNumber, quantity: 1 }],
          promotionCodes: [code],
        },
        limited,
      );
      expect(result.problems).toContainEqual(
        expect.objectContaining({
          key: "promotion-not-found",
          explanation: `"${code}" belongs to "e2e ${code}", but it is not assigned to any sales channel`,
        }),
      );

      // Run again, as after an upgrade: the role is brought up to date and the keys stay.
      const update = await applySetup(session, await planSetup(session, options), options);
      expect(update).toMatchObject({
        role: { created: false, added: [], removed: [] },
        integration: { created: false, rotated: false },
        credentials: null,
      });

      const again = await planSetup(session, { ...options, rotate: true });
      const rotated = await applySetup(session, again, { ...options, rotate: true });
      expect(rotated).toMatchObject({
        role: { created: false, added: [], removed: [] },
        integration: { created: false, rotated: true },
      });
      expect(rotated.credentials?.clientId).not.toBe(keys.clientId);
    } finally {
      await admin.client.request(`/api/promotion/${promotionId}`, { method: "DELETE" });
      await admin.client.request(`/api/integration/${created.integration.id}`, {
        method: "DELETE",
      });
      await admin.client.request(`/api/acl-role/${created.role.id}`, { method: "DELETE" });
    }
  });
});
