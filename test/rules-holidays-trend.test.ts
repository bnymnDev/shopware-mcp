import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { describe, expect, it } from "vitest";
import type { Brief } from "../src/brief.js";
import { runAudit } from "../src/tools/audit.js";
import { easter, holidayCountryOf, holidayOn, holidaysOf } from "../src/tools/holidays.js";
import { computePulse } from "../src/tools/pulse.js";
import { loadRules, rulesFromEnv } from "../src/tools/rules.js";
import { healthScore, recordTrend, sparkline, trendText } from "../src/trend.js";
import { createContext, fixture, mock, SHOP_URL, searchHandler } from "./helpers/shopware.js";

const ctx = createContext();
const scratch = () => mkdtempSync(join(tmpdir(), "swmcp-rules-"));

describe("audit rules of the shop's own", () => {
  const rules = [
    {
      id: "customers_without_group",
      title: "Customers without a customer group",
      severity: "warning" as const,
      entity: "customer",
      filter: [{ type: "equals", field: "groupId", value: null }],
      hint: "Assign a group so prices and rules apply.",
    },
    {
      id: "media_without_alt",
      title: "Images without alt text",
      entity: "media",
      filter: [{ type: "equals", field: "alt", value: null }],
    },
  ];

  it("runs them next to the built-in checks and leaves out what the role may not read", async () => {
    const bodies: Record<string, unknown> = {};
    mock.use(searchHandler({}));
    mock.use(
      http.post(`${SHOP_URL}/api/search/:entity`, async ({ request, params }) => {
        const entity = String(params.entity);
        if (entity === "customer") {
          bodies.customer = await request.clone().json();
          return HttpResponse.json({
            total: 2,
            data: [
              { id: "c1", customerNumber: "10001" },
              { id: "c2", customerNumber: "10002" },
            ],
          });
        }
        if (entity === "media") {
          return HttpResponse.json(
            { errors: [{ status: "403", code: "DENIED" }] },
            { status: 403 },
          );
        }
        return undefined;
      }),
    );
    const report = await runAudit(ctx.client, {
      stuckOrderDays: 7,
      lowStockThreshold: 5,
      forecastDays: 14,
      maxItems: 5,
      complianceChecks: false,
      timeZone: "UTC",
      rules,
    });
    const finding = report.findings.find((entry) => entry.id === "customers_without_group");
    expect(finding).toEqual({
      id: "customers_without_group",
      severity: "warning",
      title: "Customers without a customer group",
      count: 2,
      items: [
        { id: "c1", label: "10001" },
        { id: "c2", label: "10002" },
      ],
      hint: "Assign a group so prices and rules apply.",
      custom: true,
    });
    expect(bodies.customer).toMatchObject({
      limit: 5,
      filter: [{ type: "equals", field: "groupId", value: null }],
    });
    expect(report.notCovered).toContain("media_without_alt (needs media:read)");
    expect(report.parameters).toMatchObject({ customRules: 2 });
  });

  it("reads rules from a file and names what is wrong with a broken one", () => {
    const dir = scratch();
    const good = join(dir, "rules.json");
    writeFileSync(good, JSON.stringify({ rules }));
    expect(loadRules(good)).toHaveLength(2);
    expect(rulesFromEnv({ SHOPWARE_MCP_RULES: good })).toHaveLength(2);
    expect(rulesFromEnv({})).toEqual([]);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify([{ ...rules[0], id: "Not OK" }]));
    expect(() => loadRules(bad)).toThrow(/0\.id: id: lower-case/);
    writeFileSync(bad, JSON.stringify([rules[0], rules[0]]));
    expect(() => loadRules(bad)).toThrow(/appears twice/);
  });
});

describe("holidays", () => {
  it("knows Easter and the holidays that hang on it", () => {
    expect(easter(2026)).toEqual({ month: 4, day: 5 });
    expect(easter(2027)).toEqual({ month: 3, day: 28 });
    const de = holidaysOf("DE", 2026);
    expect(de.get("2026-04-03")).toBe("Good Friday");
    expect(de.get("2026-05-14")).toBe("Ascension Day");
    expect(de.get("2026-05-25")).toBe("Whit Monday");
    expect(de.get("2026-10-03")).toBe("German Unity Day");
    expect(holidayOn("2026-06-04", "AT")).toBe("Corpus Christi");
    expect(holidayOn("2026-06-04", "DE")).toBeNull();
    expect(holidayOn("2026-08-01", "CH")).toBe("Swiss National Day");
    expect(holidayCountryOf("Europe/Berlin")).toBe("DE");
    expect(holidayCountryOf("America/New_York")).toBeNull();
  });

  it("leaves a holiday out of what the pulse calls usual", async () => {
    const bodies: Array<{ aggregations?: unknown[] }> = [];
    mock.use(
      http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
        const body = (await request.clone().json()) as { sort?: unknown };
        bodies.push(body);
        return HttpResponse.json(
          (body.sort ? fixture("pulse-last-order") : fixture("pulse-aggregations")) as JsonBodyType,
        );
      }),
    );
    // Saturday 10 October 2026: the Saturday before was German Unity Day.
    const now = new Date("2026-10-10T15:00:00.000Z");
    const pulse = await computePulse(ctx.client, { weeks: 8, timeZone: "Europe/Berlin", now });
    expect(pulse.typical.weeks).toBe(7);
    expect(pulse.typical.skippedHolidays).toEqual([
      { date: "2026-10-03", name: "German Unity Day" },
    ]);
    expect(pulse.history.map((week) => week.weeksAgo)).not.toContain(1);

    const all = await computePulse(ctx.client, {
      weeks: 8,
      timeZone: "Europe/Berlin",
      holidays: "none",
      now,
    });
    expect(all.typical.weeks).toBe(8);
    expect(all.typical).not.toHaveProperty("skippedHolidays");

    const onTheDay = await computePulse(ctx.client, {
      weeks: 8,
      timeZone: "Europe/Berlin",
      now: new Date("2026-12-24T10:00:00.000Z"),
    });
    expect(onTheDay.today.holiday).toBe("Christmas Eve");
  });
});

describe("health trend", () => {
  const brief = (date: string, critical: number, warning: number, findings: string[]) =>
    ({
      generatedAt: `${date}T06:00:00.000Z`,
      timeZone: "Europe/Berlin",
      pulse: {
        today: { orders: 12, revenue: 640 },
        silence: { verdict: "normal" },
        payments: { verdict: "normal" },
      },
      audit: {
        summary: { critical, warning },
        findings: findings.map((id) => ({ id, severity: "warning" })),
      },
    }) as unknown as Brief;

  it("scores a day so a person can say why it moved", () => {
    expect(healthScore(brief("2026-11-04", 0, 0, []))).toBe(100);
    expect(healthScore(brief("2026-11-04", 1, 3, []))).toBe(65);
    expect(healthScore(brief("2026-11-04", 9, 0, []))).toBe(0);
    expect(sparkline([0, 50, 100])).toBe("▁▅█");
  });

  it("keeps one score per day and compares with a week ago", () => {
    const file = join(scratch(), "nested", "health.json");
    const first = recordTrend(file, brief("2026-10-28", 0, 1, ["orders_unpaid_old"]));
    expect(first).toMatchObject({ changeOverWeek: null, newFindings: [] });
    recordTrend(file, brief("2026-11-03", 0, 1, ["orders_unpaid_old"]));
    // A second run on the same day replaces that day.
    recordTrend(file, brief("2026-11-04", 0, 0, []));
    const trend = recordTrend(file, brief("2026-11-04", 1, 1, ["orders_unpaid_old", "x"]));
    expect(trend.days.map((day) => day.date)).toEqual(["2026-10-28", "2026-11-03", "2026-11-04"]);
    expect(trend.today.score).toBe(75);
    expect(trend.changeOverWeek).toBe(-20);
    expect(trend.newFindings).toEqual(["orders_unpaid_old", "x"]);
    expect(trendText(trend)).toBe(
      "Health 75/100 (-20 vs a week ago) ███▇; new since the last brief: orders_unpaid_old, x".replace(
        "███▇",
        sparkline([95, 95, 75]),
      ),
    );
    const stored = JSON.parse(readFileSync(file, "utf8")) as { days: unknown[] };
    expect(stored.days).toHaveLength(3);
  });

  it("starts afresh from a file it cannot read", () => {
    const file = join(scratch(), "health.json");
    writeFileSync(file, "not json");
    expect(recordTrend(file, brief("2026-11-04", 0, 0, [])).days).toHaveLength(1);
  });
});

describe("health trend on the page", () => {
  it("draws the scores and names new findings", async () => {
    const { trendSection } = await import("../src/html.js");
    const html = trendSection({
      days: [
        { date: "2026-11-03", score: 95, critical: 0, warning: 1, orders: 10, revenue: 500 },
        { date: "2026-11-04", score: 75, critical: 1, warning: 1, orders: 4, revenue: 210 },
      ],
      today: { date: "2026-11-04", score: 75, critical: 1, warning: 1, orders: 4, revenue: 210 },
      changeOverWeek: -20,
      newFindings: ["products_below_cost"],
    });
    expect(html).toContain("<h2>Health trend</h2>");
    expect(html).toContain("▼ −20");
    expect(html).toContain("New since the last brief: products_below_cost");
    expect(html).toContain("1 critical, 1 warning, 4 orders");
  });
});
