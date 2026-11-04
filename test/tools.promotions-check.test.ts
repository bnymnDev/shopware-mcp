import { describe, expect, it } from "vitest";
import { checkPromotions, promotionsCheck } from "../src/tools/promotions-check.js";
import {
  createContext,
  fixture,
  invoke,
  lastSearch,
  mock,
  searchHandler,
} from "./helpers/shopware.js";

const ctx = createContext();
const NOW = new Date("2026-11-04T17:37:28.333Z");
const UNTIL = new Date("2026-12-01T23:59:59.999Z");
type Body = Record<string, unknown>;

const realShop = (overrides: Record<string, () => unknown> = {}) =>
  searchHandler({
    promotion: "promotions-check-promotions",
    "sales-channel": "promotions-check-channels",
    "promotion-individual-code": "promotions-check-codes",
    ...overrides,
  });

const byName = (result: Awaited<ReturnType<typeof checkPromotions>>, name: string) =>
  result.promotions.find((promotion) => promotion.name === name);

describe("promotions_check", () => {
  it("finds what would break a Black Friday prepared in a real shop", async () => {
    mock.use(realShop());
    const result = await checkPromotions(ctx.client, { until: UNTIL, now: NOW });

    // Inactive promotions are checked too: a campaign never switched on is the classic mistake.
    const body = lastSearch("promotion").body as Body;
    expect(JSON.stringify(body.filter)).not.toContain('"active"');
    expect(JSON.stringify(body.filter)).toContain(
      '"validFrom","parameters":{"lte":"2026-12-01T23:59:59.999Z"}',
    );

    expect(result).toMatchObject({ checked: 8, complete: true });
    expect(result.summary).toEqual({ critical: 3, warning: 4, info: 3, ready: 1 });
    expect(byName(result, "Black Friday 30 %")?.findings[0]).toEqual({
      severity: "warning",
      problem: "starts on 2026-11-27 but is inactive: it will not switch itself on",
    });
    expect(byName(result, "Free shipping weekend")?.findings).toEqual([
      {
        severity: "critical",
        problem: "has no discount: Shopware refuses it, customers get nothing",
      },
      { severity: "info", problem: "ends on 2026-11-29, before the end of the window" },
    ]);
    expect(byName(result, "Autumn 10 % for everyone")?.findings).toEqual([
      {
        severity: "warning",
        problem:
          'applies automatically together with "Black Week 15 % automatic": the discounts add up',
      },
    ]);
    expect(byName(result, "App only 5 %")?.findings[0]?.problem).toBe(
      "is assigned to no sales channel: it applies nowhere",
    );
    expect(byName(result, "Influencer codes")?.findings[0]?.problem).toBe(
      "uses individual codes, but none is left unused",
    );
    expect(byName(result, "VIP 60 %")?.findings[0]?.problem).toContain("60 % off without a cap");
    expect(byName(result, "Newsletter 10 %")).toMatchObject({
      findings: [],
      kind: "code",
      salesChannels: ["Storefront"],
    });
    // Worst first.
    expect(result.promotions[0]?.findings[0]?.severity).toBe("critical");
    expect(result.promotions.at(-1)?.findings).toEqual([]);
  });

  it("flags maintenance, limits, a free cart, a reversed window and a start in two days", async () => {
    const promotions = fixture<{ data: Body[]; total: number }>("promotions-check-promotions");
    const base = promotions.data.find((entry) => entry.name === "Newsletter 10 %") ?? {};
    const variant = (patch: Body) => ({
      ...structuredClone(base),
      ...patch,
      translated: { name: patch.name },
    });
    const discounts = (value: number) => [{ id: "d1", type: "percentage", value, maxValue: null }];
    promotions.data = [
      variant({ id: "a", name: "Limit used", maxRedemptionsGlobal: 10, orderCount: 10 }),
      variant({ id: "b", name: "Limit near", maxRedemptionsGlobal: 10, orderCount: 8 }),
      variant({ id: "c", name: "Free cart", discounts: discounts(100) }),
      variant({
        id: "d",
        name: "Reversed",
        validFrom: "2026-11-20T00:00:00.000+00:00",
        validUntil: "2026-11-10T00:00:00.000+00:00",
      }),
      variant({
        id: "e",
        name: "Tomorrow",
        active: false,
        validFrom: "2026-11-05T08:00:00.000+00:00",
      }),
      variant({ id: "f", name: "Few codes", useIndividualCodes: true, code: null }),
    ];
    promotions.total = promotions.data.length;
    const channels = fixture<{ data: Body[] }>("promotions-check-channels");
    for (const channel of channels.data) channel.maintenance = true;
    mock.use(
      realShop({
        promotion: () => promotions,
        "sales-channel": () => channels,
        "promotion-individual-code": () => ({
          total: 0,
          data: [],
          aggregations: { unused: { buckets: [{ key: "f", count: 5 }] } },
        }),
      }),
    );
    const result = await checkPromotions(ctx.client, { until: UNTIL, now: NOW });
    const problems = (name: string) => byName(result, name)?.findings.map((f) => f.problem) ?? [];
    expect(problems("Limit used")).toContain("has used all 10 redemptions");
    expect(problems("Limit near")).toContain(
      "has used 8 of 10 redemptions; it may run out during the campaign",
    );
    expect(problems("Free cart")).toContain("gives 100 % off: the cart becomes free");
    expect(problems("Reversed")).toContain("ends (2026-11-10) before it starts (2026-11-20)");
    expect(byName(result, "Tomorrow")?.findings[0]).toEqual({
      severity: "critical",
      problem: "starts on 2026-11-05 but is inactive: it will not switch itself on",
    });
    expect(problems("Few codes")).toContain("only 5 unused individual codes left");
    expect(problems("Limit used")).toContain(
      "runs only in Storefront, which is inactive or in maintenance",
    );
  });

  it("defaults to the next 14 days and refuses a window in the past", async () => {
    mock.use(realShop());
    const result = await invoke(promotionsCheck, {}, ctx);
    const days = (Date.parse(result.window.until) - Date.parse(result.window.from)) / 86_400_000;
    expect(days).toBeCloseTo(14, 3);
    await expect(invoke(promotionsCheck, { until: "2020-01-01" }, ctx)).rejects.toMatchObject({
      status: 400,
    });
  });
});
