import { describe, expect, it } from "vitest";
import { describeItem, formatAuditMarkdown, formatSalesReportMarkdown } from "../src/format.js";
import { shopAudit } from "../src/tools/audit.js";
import { salesReport } from "../src/tools/reports.js";
import { createContext, invoke, mock, searchHandler } from "./helpers/shopware.js";

const ctx = createContext();

describe("Markdown formatters", () => {
  it("renders the audit with severities, samples and hints", async () => {
    const audit = await invoke(shopAudit, {}, ctx);
    const text = formatAuditMarkdown(audit);
    expect(text).toMatch(/^# Shop audit · https:\/\/shop\.test \(Shopware 6\.6\.10\.3 Community\)/);
    expect(text).toContain("## Critical");
    expect(text).toContain("### Paid orders not shipped for more than 7 days (3)");
    expect(text).toContain("- #10042 ·");
    expect(text).toContain("> Ship or communicate a delay");
    expect(text).toContain("days of cover");
    expect(text).not.toContain("undefined");
  });

  it("describes items from whichever fields they carry", () => {
    expect(describeItem({ productNumber: "SW1", name: "Mug", stock: 2 })).toBe(
      "SW1 · Mug · stock 2",
    );
    expect(describeItem({ salesChannel: "Storefront", missing: ["imprint", "privacy"] })).toBe(
      "Storefront · missing: imprint, privacy",
    );
    expect(describeItem({ foo: 1, bar: "x" })).toBe("foo: 1, bar: x");
    expect(describeItem("plain")).toBe("plain");
  });

  it("renders the sales report with comparison, channels, timeline and top products", async () => {
    mock.use(
      searchHandler({
        order: "order-aggregations",
        "order-line-item": "line-item-aggregations",
        product: "products-search",
      }),
    );
    const report = await invoke(
      salesReport,
      { from: "2024-06-01", to: "2024-06-30", compareWithPrevious: true },
      ctx,
    );
    const text = formatSalesReportMarkdown(report);
    expect(text).toMatch(/^# Sales report · 2024-06-01 to 2024-06-30/);
    expect(text).toContain("| Orders |");
    expect(text).toContain("## By sales channel");
    expect(text).toContain("## Timeline (day)");
    expect(text).toContain("## Top products");
    expect(text).toContain("(0 %)");
    expect(text).not.toContain("undefined");
  });
});

describe("Markdown safety", () => {
  it("neutralises control characters and pipes from shop data", () => {
    const line = describeItem({
      productNumber: "SW1|2",
      name: "Mug\n# Critical\n- fake \u001b[31mred",
      stock: 1,
    });
    expect(line).toBe("SW1\\|2 · Mug # Critical - fake  [31mred · stock 1");
    expect([...line].some((char) => char.charCodeAt(0) < 32)).toBe(false);
    expect(describeItem({ weird: "a|b" })).toBe("weird: a\\|b");
  });
});
