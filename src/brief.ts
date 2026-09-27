import { DEFAULT_CURRENCY_ID } from "./client/constants.js";
import type { ShopwareClient } from "./client/index.js";
import {
  auditSection,
  duration,
  esc,
  money,
  odds,
  pulseSection,
  renderPage,
  salesSection,
} from "./html.js";
import { runAudit } from "./tools/audit.js";
import { computePulse, type Pulse } from "./tools/pulse.js";
import { buildSalesReport } from "./tools/reports.js";

type AuditReport = Awaited<ReturnType<typeof runAudit>>;
type SalesReport = Awaited<ReturnType<typeof buildSalesReport>>;

export interface Brief {
  shop: string;
  generatedAt: string;
  timeZone: string;
  currency: string | null;
  pulse: Pulse;
  audit: AuditReport;
  sales: SalesReport;
}

const localDate = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(date);

/** The pulse, the audit and the last seven days: what a shop manager wants before coffee. */
export async function buildBrief(
  client: ShopwareClient,
  options: { timeZone: string; now?: Date },
): Promise<Brief> {
  const now = options.now ?? new Date();
  const to = localDate(now, options.timeZone);
  const from = localDate(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000), options.timeZone);
  const [pulse, audit, sales, currency] = await Promise.all([
    computePulse(client, { weeks: 8, timeZone: options.timeZone, now }),
    runAudit(client, {
      stuckOrderDays: 7,
      lowStockThreshold: 5,
      forecastDays: 14,
      maxItems: 5,
      complianceChecks: false,
    }),
    buildSalesReport(client, {
      from,
      to,
      interval: "day",
      excludeCancelled: true,
      topProducts: 5,
      compareWithPrevious: true,
    }),
    client.currencyCode(DEFAULT_CURRENCY_ID).catch(() => null),
  ]);
  return {
    shop: audit.shop?.url ?? client.baseUrl,
    generatedAt: now.toISOString(),
    timeZone: options.timeZone,
    currency: sales.revenueByCurrency[0]?.currency ?? currency,
    pulse,
    audit,
    sales,
  };
}

const stamp = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : ` (${value > 0 ? "+" : ""}${value} %)`;

/** One sentence on the quiet spell or the payments, whichever is worth reading first. */
export function pulseHeadline(pulse: Pulse): {
  level: "critical" | "warning" | "ok";
  text: string;
} {
  const silence = pulse.silence;
  if (silence && silence.verdict !== "normal") {
    return {
      level: silence.verdict === "unusual" ? "critical" : "warning",
      text:
        `No order for ${duration(silence.minutes)}; the same hours of the last ` +
        `${pulse.typical.weeks} weeks brought ${silence.expectedOrders} on average ` +
        `(by chance ${odds(silence.chance)} times)`,
    };
  }
  if (pulse.payments.verdict !== "normal") {
    return {
      level: pulse.payments.verdict === "unusual" ? "critical" : "warning",
      text:
        `${pulse.payments.today.failedOrCancelled} of ${pulse.payments.today.total} payments ` +
        `failed or were cancelled today; usually ${Math.round(pulse.payments.typicalFailedShare * 100)} %`,
    };
  }
  return { level: "ok", text: "Orders are arriving as usual" };
}

export function formatBriefMarkdown(brief: Brief): string {
  const { pulse, audit, sales, currency } = brief;
  const headline = pulseHeadline(pulse);
  const lines = [
    `# Shop brief · ${brief.shop}`,
    "",
    `${stamp(brief.generatedAt, brief.timeZone)} (${brief.timeZone})`,
    "",
    "## Right now",
    "",
    `${headline.level === "ok" ? "" : `**${headline.level === "critical" ? "Unusual" : "Watch"}:** `}${headline.text}.`,
    "",
    `- Orders today: ${pulse.today.orders}${pct(pulse.change.orders)} vs ${pulse.typical.orders} on a typical day like this`,
    `- Revenue today: ${money(pulse.today.revenue, currency)}${pct(pulse.change.revenue)}`,
    `- Last order: ${pulse.lastOrder ? `#${pulse.lastOrder.orderNumber}, ${duration(pulse.lastOrder.minutesAgo ?? 0)} ago` : "none yet"}`,
    `- Failed payments today: ${pulse.payments.today.failedOrCancelled} of ${pulse.payments.today.total}`,
    "",
    "## Audit",
    "",
    `${audit.summary.checksRun} checks · ${audit.summary.critical} critical, ${audit.summary.warning} warning, ${audit.summary.info} info`,
    "",
    ...audit.findings.map(
      (finding) => `- **${finding.severity}** ${finding.title} (${finding.count})`,
    ),
    "",
    "## Last 7 days",
    "",
    `- Revenue: ${money(sales.totals.revenueGross, currency)}${pct(sales.change?.revenueGross.percent)}`,
    `- Orders: ${sales.totals.orders}${pct(sales.change?.orders.percent)}`,
    `- Average order: ${money(sales.totals.averageOrderValue, currency)}${pct(sales.change?.averageOrderValue.percent)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderBriefHtml(brief: Brief): string {
  return renderPage({
    title: "Shop brief",
    shop: brief.shop,
    generatedAt: `${stamp(brief.generatedAt, brief.timeZone)} (${brief.timeZone})`,
    sections: [
      pulseSection(brief.pulse, brief.currency),
      auditSection(brief.audit, 3, { foldInfo: true }),
      salesSection(brief.sales),
    ],
  });
}

export function renderAuditHtml(audit: AuditReport, timeZone: string): string {
  return renderPage({
    title: "Shop audit",
    shop: audit.shop?.url ?? "",
    generatedAt: `${stamp(audit.generatedAt, timeZone)} (${timeZone})`,
    sections: [auditSection(audit, 10)],
  });
}

export function renderSalesHtml(report: SalesReport, shop: string, timeZone: string): string {
  return renderPage({
    title: "Sales report",
    shop,
    generatedAt: `${stamp(new Date().toISOString(), timeZone)} (${timeZone})`,
    sections: [salesSection(report, "Sales")],
  });
}

/* ------------------------------------------------------------------------------------------
 * Slack: a few lines for a channel, the details stay in the HTML or the terminal.
 * ---------------------------------------------------------------------------------------- */

const SLACK_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
/** Slack's mrkdwn only needs &, < and > escaped; `<…>` would otherwise become a link. */
const slack = (value: unknown) =>
  String(value ?? "").replace(/[&<>]/g, (char) => SLACK_ESCAPES[char] ?? char);

const MARKS = {
  critical: ":red_circle:",
  warning: ":large_yellow_circle:",
  ok: ":large_green_circle:",
};

export function auditSlackText(audit: AuditReport): string {
  const { summary } = audit;
  const level = summary.critical > 0 ? "critical" : summary.warning > 0 ? "warning" : "ok";
  return [
    `${MARKS[level]} *Shop audit · ${slack(audit.shop?.url ?? "")}*`,
    `${summary.critical} critical · ${summary.warning} warning · ${summary.info} info (${summary.checksRun} checks)`,
    ...audit.findings
      .filter((finding) => finding.severity !== "info")
      .slice(0, 8)
      .map((finding) => `• ${slack(finding.title)} (${finding.count})`),
  ].join("\n");
}

export function briefSlackText(brief: Brief): string {
  const headline = pulseHeadline(brief.pulse);
  const { pulse, sales, currency } = brief;
  return [
    `${MARKS[headline.level]} *Shop brief · ${slack(brief.shop)}* · ${slack(stamp(brief.generatedAt, brief.timeZone))}`,
    slack(headline.text),
    `Today: ${pulse.today.orders} orders${pct(pulse.change.orders)}, ${slack(money(pulse.today.revenue, currency))}`,
    `Last 7 days: ${slack(money(sales.totals.revenueGross, currency))}${pct(sales.change?.revenueGross.percent)}, ${sales.totals.orders} orders`,
    "",
    auditSlackText(brief.audit),
  ].join("\n");
}

/** POST a message to a Slack incoming webhook (or anything that takes `{ text }`). */
export async function postWebhook(
  url: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("The webhook URL must use https");
  const response = await fetchImpl(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`The webhook answered ${response.status} ${esc(response.statusText)}`);
  }
}
