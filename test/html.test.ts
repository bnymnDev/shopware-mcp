import { HttpResponse, http, type JsonBodyType } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  briefSlackText,
  buildBrief,
  formatBriefMarkdown,
  postWebhook,
  pulseHeadline,
  renderBriefHtml,
} from "../src/brief.js";
import {
  auditSection,
  columnChart,
  dayLabels,
  duration,
  esc,
  odds,
  pulseSection,
} from "../src/html.js";
import { runAudit } from "../src/tools/audit.js";
import { computePulse, type Pulse } from "../src/tools/pulse.js";
import { createContext, fixture, mock, SHOP_URL } from "./helpers/shopware.js";

const ctx = createContext();
const NOW = new Date("2026-09-27T18:01:38.402Z");

afterEach(() => {
  vi.useRealTimers();
});

/** Order searches answered like a real shop: pulse, sales aggregations, audit lists. */
function shop() {
  return http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
    const body = (await request.clone().json()) as {
      sort?: { order?: string }[];
      limit?: number;
      aggregations?: { name?: string }[];
    };
    const name =
      body.sort?.[0]?.order === "DESC" && body.limit === 1
        ? "pulse-last-order"
        : body.aggregations?.some((agg) => agg.name === "o0")
          ? "pulse-aggregations"
          : body.aggregations
            ? "order-aggregations"
            : "orders-search";
    return HttpResponse.json(fixture<JsonBodyType>(name));
  });
}

async function pulse(): Promise<Pulse> {
  mock.use(shop());
  return computePulse(ctx.client, { weeks: 8, timeZone: "Europe/Berlin", now: NOW });
}

describe("text helpers", () => {
  it("escapes shop data and words numbers the way people read them", () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe(
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
    );
    expect(odds(0.0098)).toBe("about 1 in 100");
    expect(odds(0.2)).toBe("about 1 in 5");
    expect(odds(0.0004)).toBe("about 1 in 3,000");
    expect(odds(0.8)).toBe("more often than not");
    expect(duration(45)).toBe("45 min");
    expect(duration(359)).toBe("5 h 59 min");
    expect(duration(120)).toBe("2 h");
    expect(duration(4000)).toBe("2 days");
    expect(dayLabels(["2026-08-30", "2026-09-06", "2026-09-13", ""])).toEqual([
      "Aug 30",
      "Sep 6",
      "13",
      "",
    ]);
  });
});

describe("columnChart", () => {
  it("draws thin rounded columns from one baseline, with a table twin and safe tooltips", () => {
    const svg = columnChart({
      caption: "Orders <by> hour",
      valueHeader: "Orders",
      format: (value) => String(value),
      reference: { value: 5, label: "typical 5" },
      columns: [
        { label: "Mon", value: 4 },
        { label: "<script>alert(1)</script>", value: 0 },
        { label: "Today", value: 8, emphasis: true, labelled: true },
      ],
    });
    expect(svg).toContain("<figcaption>Orders &lt;by&gt; hour</figcaption>");
    expect(svg).not.toContain("<script>");
    expect(svg.match(/<path class="bar/g)).toHaveLength(2);
    expect(svg).toContain('class="bar context"');
    expect(svg).toContain('class="bar accent"');
    expect(svg).toMatch(/Q[\d.]+,[\d.]+ [\d.]+,[\d.]+ H/);
    expect(svg).toContain('<line class="zero context"');
    expect(svg).toContain(">typical 5</text>");
    expect(svg).toContain('class="cap"');
    expect(svg.match(/<tr>/g)).toHaveLength(4);
    expect(svg.match(/tabindex="0"/g)).toHaveLength(3);
    // Every hover area spans the plot from its top, however short the bar.
    const hits = [...svg.matchAll(/<rect class="hit" x="[\d.]+" y="([\d.]+)"/g)].map((m) => m[1]);
    expect(hits).toEqual(["18", "18", "18"]);
    const widths = [...svg.matchAll(/H([\d.]+) Q([\d.]+),/g)].map(
      (m) => Number(m[2]) - Number(m[1]),
    );
    expect(widths.every((width) => width <= 24)).toBe(true);
  });
});

describe("pulse section", () => {
  it("explains an unusual silence with the evidence and the odds", async () => {
    const html = pulseSection(await pulse(), "EUR");
    expect(html).toContain('class="banner critical"');
    expect(html).toContain("Unusual silence");
    expect(html).toContain("No order for <strong>5 h 59 min</strong>, since 14:01");
    expect(html).toContain("orders came in every time");
    expect(html).toContain("about 1 in 100");
    expect(html).toContain("Orders by 20:01 on the last 8 Sundays and today");
    expect(html).toContain("Orders between 14:01 and 20:01 on the same weekday");
    expect(html).toContain("€142,679");
  });

  it("does not claim every week had orders when one did not", async () => {
    const value = await pulse();
    if (!value.silence) throw new Error("expected a silence");
    value.silence.sameGapInPreviousWeeks = [6, 4, 3, 5, 0, 5, 5, 6];
    expect(pulseSection(value, "EUR")).toContain("7 of 8 brought orders");
  });

  it("says so when orders arrive as usual", async () => {
    const value = await pulse();
    if (!value.silence) throw new Error("expected a silence");
    value.silence.verdict = "normal";
    expect(pulseSection(value, "EUR")).toContain("Orders arriving as usual");
    expect(pulseHeadline(value)).toEqual({ level: "ok", text: "Orders are arriving as usual" });
  });
});

describe("the brief", () => {
  it("combines pulse, audit and the last seven days in Markdown, HTML and Slack", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mock.use(shop());
    const brief = await buildBrief(ctx.client, { timeZone: "Europe/Berlin" });
    expect(brief).toMatchObject({ shop: "https://shop.test", timeZone: "Europe/Berlin" });
    // Seven local days: from Berlin's midnight six days ago up to this moment.
    expect(brief.sales.period).toMatchObject({
      from: "2026-09-20T22:00:00.000Z",
      to: NOW.toISOString(),
      timeZone: "Europe/Berlin",
      running: true,
    });

    const markdown = formatBriefMarkdown(brief);
    expect(markdown).toMatch(/^# Shop brief · https:\/\/shop\.test/);
    expect(markdown).toContain("**Unusual:** No order for 5 h 59 min");
    expect(markdown).toContain("- **critical** No orders for an unusually long time (1)");

    const html = renderBriefHtml(brief);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain('<details class="more">');
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=/);

    const slack = briefSlackText(brief);
    expect(slack.split("\n")[0]).toMatch(/^:red_circle: \*Shop brief · https:\/\/shop\.test\*/);
    expect(slack).toContain("No order for 5 h 59 min");
  });

  it("folds info findings into one closed details block", async () => {
    const audit = await runAudit(ctx.client, {
      stuckOrderDays: 7,
      lowStockThreshold: 5,
      forecastDays: 14,
      maxItems: 5,
      complianceChecks: false,
    });
    const info = audit.findings.filter((finding) => finding.severity === "info").length;
    const folded = auditSection(audit, 3, { foldInfo: true });
    expect(folded).toContain(`${info} info findings</summary>`);
    expect(auditSection(audit)).not.toContain('<details class="more">');
  });
});

describe("postWebhook", () => {
  it("posts JSON with the text and refuses plain http", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("ok");
    }) as unknown as typeof fetch;
    await postWebhook("https://hooks.slack.test/a", "hello <b>", fake);
    expect(calls[0]?.url).toBe("https://hooks.slack.test/a");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: "hello <b>" });
    expect(calls[0]?.init).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    await expect(postWebhook("http://hooks.slack.test/a", "x", fake)).rejects.toThrow(/https/);
  });
});
