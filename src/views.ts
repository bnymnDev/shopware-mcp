import { z } from "zod";
import { buildBrief, pulseHeadline } from "./brief.js";
import { DEFAULT_CURRENCY_ID } from "./client/constants.js";
import { badRequest } from "./errors.js";
import { auditSection, pulseSection, salesSection, trendSection } from "./html.js";
import type { runAudit } from "./tools/audit.js";
import { defaultTimeZone, isTimeZone, type Pulse } from "./tools/pulse.js";
import type { buildSalesReport } from "./tools/reports.js";
import { defineTool, type ToolContext } from "./tools/types.js";

type AuditReport = Awaited<ReturnType<typeof runAudit>>;
type SalesReport = Awaited<ReturnType<typeof buildSalesReport>>;
type Brief = Awaited<ReturnType<typeof buildBrief>>;

/**
 * What a tool's result looks like as a page in an MCP Apps host. The JSON the model reads
 * stays as it is; the page is extra, for the person looking at the chat.
 */
export type View = (result: unknown, ctx: ToolContext) => Promise<string>;

/** A result may carry data only its view needs; JSON drops symbol keys, so the model never sees it. */
export const VIEW_DATA = Symbol("view data");

const currencyOf = (ctx: ToolContext) =>
  ctx.client.currencyCode(DEFAULT_CURRENCY_ID).catch(() => null);

export const VIEWS: Record<string, View> = {
  shop_pulse: async (result, ctx) => pulseSection(result as Pulse, await currencyOf(ctx)),
  shop_audit: async (result) => auditSection(result as AuditReport, 10),
  sales_report: async (result) => salesSection(result as SalesReport, "Sales"),
  shop_brief: async (result) => {
    const brief = (result as { [VIEW_DATA]?: Brief })[VIEW_DATA];
    if (!brief) return "";
    return [
      pulseSection(brief.pulse, brief.currency),
      ...(brief.trend ? [trendSection(brief.trend)] : []),
      auditSection(brief.audit, 3, { foldInfo: true }),
      salesSection(brief.sales),
    ].join("\n");
  },
};

/** The brief as a tool: a short summary for the model, the whole page for the person. */
export const shopBrief = defineTool({
  name: "shop_brief",
  title: "Shop brief",
  description:
    "One look at the whole shop, as a manager wants it in the morning: orders and payments " +
    "right now against a usual day, the audit's findings, and the last seven days' revenue. " +
    "Hosts that show MCP Apps get it as an interactive page with charts. Read-only. Returns " +
    "{ headline, today, audit, last7Days } in short; use shop_pulse, shop_audit or " +
    "sales_report for the details of one part.",
  inputSchema: {
    timeZone: z
      .string()
      .trim()
      .optional()
      .describe("IANA time zone of the shop, e.g. Europe/Berlin; default: the server's"),
  },
  handler: async (input, ctx) => {
    const timeZone = input.timeZone ?? defaultTimeZone();
    if (!isTimeZone(timeZone)) throw badRequest(`Unknown time zone "${timeZone}"`);
    const brief = await buildBrief(ctx.client, { timeZone });
    const { pulse, audit, sales } = brief;
    return {
      shop: brief.shop,
      headline: pulseHeadline(pulse),
      today: {
        orders: pulse.today.orders,
        typicalOrders: pulse.typical.orders,
        revenue: pulse.today.revenue,
        currency: brief.currency,
        lastOrderMinutesAgo: pulse.lastOrder?.minutesAgo ?? null,
        failedPayments: pulse.payments.today.failedOrCancelled,
      },
      audit: {
        ...audit.summary,
        findings: audit.findings.map((finding) => ({
          severity: finding.severity,
          title: finding.title,
          count: finding.count,
        })),
      },
      last7Days: {
        revenue: sales.totals.revenueGross,
        orders: sales.totals.orders,
        averageOrder: sales.totals.averageOrderValue,
        change: sales.change
          ? {
              revenue: sales.change.revenueGross.percent,
              orders: sales.change.orders.percent,
            }
          : null,
      },
      [VIEW_DATA]: brief,
    };
  },
});
