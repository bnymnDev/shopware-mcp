import type { Raw } from "./client/index.js";
import type { runAudit } from "./tools/audit.js";
import type { buildSalesReport } from "./tools/reports.js";
import { isRaw, num, str } from "./tools/shared.js";

/** Markdown renderings of the audit and the sales report for terminals, cron mails and CI logs. */

type AuditReport = Awaited<ReturnType<typeof runAudit>>;
type SalesReport = Awaited<ReturnType<typeof buildSalesReport>>;

/**
 * Shop data ends up in mails and CI logs: control characters (line breaks, escape sequences)
 * and table pipes are neutralised so a product name cannot forge a finding or colour a terminal.
 */
const text = (value: unknown): string =>
  String(value ?? "–")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\|/g, "\\|");

const money = (value: number | null | undefined, currency?: string | null): string =>
  value === null || value === undefined
    ? "–"
    : `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`;

const day = (value: string | null | undefined): string => (value ? value.slice(0, 10) : "–");

const cell = text;

/** One line per finding item, from whichever well-known fields it carries. */
export function describeItem(item: unknown): string {
  if (!isRaw(item)) return cell(item);
  const parts: string[] = [];
  const orderNumber = str(item.orderNumber);
  const productNumber = str(item.productNumber);
  if (orderNumber) parts.push(`#${text(orderNumber)}`);
  if (productNumber) parts.push(text(productNumber));
  const name = str(item.name) ?? str(item.label) ?? str(item.title) ?? str(item.product);
  if (name) parts.push(text(name));
  if (item.orderDate) parts.push(day(str(item.orderDate)));
  if (num(item.amountTotal) !== null) parts.push(money(num(item.amountTotal), str(item.currency)));
  if (str(item.paymentState) || str(item.deliveryState)) {
    parts.push(`${str(item.paymentState) ?? "?"} / ${str(item.deliveryState) ?? "?"}`);
  }
  if (num(item.stock) !== null) parts.push(`stock ${num(item.stock)}`);
  if (num(item.daysOfCover) !== null) parts.push(`${num(item.daysOfCover)} days of cover`);
  if (num(item.points) !== null) parts.push(`${num(item.points)}/5`);
  if (str(item.code)) parts.push(`code ${str(item.code)}`);
  if (str(item.validUntil)) parts.push(`until ${day(str(item.validUntil))}`);
  if (str(item.salesChannel)) parts.push(String(item.salesChannel));
  if (Array.isArray(item.missing)) parts.push(`missing: ${item.missing.join(", ")}`);
  if (str(item.upgradeVersion))
    parts.push(`update ${str(item.version)} → ${str(item.upgradeVersion)}`);
  if (parts.length === 0) {
    const keys = Object.entries(item as Raw)
      .filter(([, value]) => value !== null && typeof value !== "object")
      .slice(0, 4)
      .map(([key, value]) => `${text(key)}: ${text(value)}`);
    return keys.join(", ") || "(item)";
  }
  return parts.join(" · ");
}

export function formatAuditMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const shop = report.shop
    ? `${report.shop.url} (Shopware ${report.shop.version ?? "?"} ${report.shop.edition ?? ""})`.trim()
    : "shop";
  lines.push(`# Shop audit · ${shop}`, "");
  const { summary } = report;
  lines.push(
    `${day(report.generatedAt)} · ${summary.checksRun} checks · ` +
      (summary.healthy
        ? "healthy, nothing critical or warning"
        : `${summary.critical} critical, ${summary.warning} warning, ${summary.info} info`),
    "",
  );
  for (const severity of ["critical", "warning", "info"] as const) {
    const findings = report.findings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) continue;
    lines.push(`## ${severity[0]?.toUpperCase()}${severity.slice(1)}`, "");
    for (const finding of findings) {
      lines.push(`### ${finding.title} (${finding.count})`, "");
      for (const item of finding.items) lines.push(`- ${describeItem(item)}`);
      if (finding.count > finding.items.length) {
        lines.push(`- … ${finding.count - finding.items.length} more`);
      }
      lines.push("", `> ${finding.hint}`, "");
    }
  }
  if (report.warnings && report.warnings.length > 0) {
    lines.push("## Skipped", "");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function changeCell(change: { absolute: number; percent: number | null } | undefined): string {
  if (!change) return "";
  const sign = change.absolute > 0 ? "+" : "";
  return change.percent === null ? ` (${sign}${change.absolute})` : ` (${sign}${change.percent} %)`;
}

export function formatSalesReportMarkdown(report: SalesReport): string {
  const lines: string[] = [];
  const { totals, period } = report;
  lines.push(`# Sales report · ${day(period.from)} to ${day(period.to)}`, "");
  lines.push("| | This period | Before |", "|---|---:|---:|");
  const rows: [string, string, string][] = [
    [
      "Orders",
      `${totals.orders}${changeCell(report.change?.orders)}`,
      report.previousPeriod ? String(report.previousPeriod.orders) : "–",
    ],
    [
      "Revenue (gross)",
      `${money(totals.revenueGross)}${changeCell(report.change?.revenueGross)}`,
      report.previousPeriod ? money(report.previousPeriod.revenueGross) : "–",
    ],
    ["Revenue (net)", money(totals.revenueNet), "–"],
    [
      "Average order",
      `${money(totals.averageOrderValue)}${changeCell(report.change?.averageOrderValue)}`,
      report.previousPeriod ? money(report.previousPeriod.averageOrderValue) : "–",
    ],
  ];
  for (const [label, current, before] of rows) lines.push(`| ${label} | ${current} | ${before} |`);
  lines.push("");

  if (report.revenueByCurrency.length > 1) {
    lines.push("## By currency", "", "| Currency | Orders | Revenue |", "|---|---:|---:|");
    for (const row of report.revenueByCurrency) {
      lines.push(`| ${cell(row.currency)} | ${row.orders} | ${money(row.revenue)} |`);
    }
    lines.push("");
  }
  if (report.revenueBySalesChannel.length > 0) {
    lines.push("## By sales channel", "", "| Channel | Orders | Revenue |", "|---|---:|---:|");
    for (const row of report.revenueBySalesChannel) {
      lines.push(`| ${cell(row.salesChannel)} | ${row.orders} | ${money(row.revenue)} |`);
    }
    lines.push("");
  }
  if (report.ordersByPaymentMethod.length > 0) {
    lines.push("## By payment method", "", "| Method | Orders |", "|---|---:|");
    for (const row of report.ordersByPaymentMethod)
      lines.push(`| ${cell(row.key)} | ${row.orders} |`);
    lines.push("");
  }
  if (report.timeline.length > 0) {
    lines.push(
      `## Timeline (${period.interval})`,
      "",
      "| Bucket | Orders | Revenue |",
      "|---|---:|---:|",
    );
    for (const row of report.timeline) {
      lines.push(`| ${day(row.bucket)} | ${row.orders} | ${money(row.revenue)} |`);
    }
    lines.push("");
  }
  if (report.topProducts.length > 0) {
    lines.push(
      "## Top products",
      "",
      "| Product | Name | Units | Revenue |",
      "|---|---|---:|---:|",
    );
    for (const row of report.topProducts) {
      lines.push(
        `| ${cell(row.productNumber)} | ${cell(row.name)} | ${row.quantity} | ${money(row.revenue)} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
