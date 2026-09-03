import { z } from "zod";
import { associations, buildCriteria, equals, searchInputShape } from "../client/criteria.js";
import type { Raw } from "../client/index.js";
import { bool, num, raw, rawList, str, toPage, withFields } from "../tools/shared.js";
import { defineTool } from "../tools/types.js";
import type { ExtensionPack } from "./types.js";

/* --------------------------------------------------------------------------------------------
 * Merqo (https://github.com/bnymnDev/merqo) — commercial Shopware extensions.
 * These tools read data the plugins already expose through the Admin API. Nothing here requires
 * a change on the Merqo side, and none of it is registered when the plugins are absent.
 * ------------------------------------------------------------------------------------------ */

const CHECK_STATUS = ["ok", "warn", "critical", "neutral"] as const;

function mapCheck(check: Raw) {
  return {
    id: str(check.id),
    status: str(check.status),
    plugin: str(check.pluginName),
    details: raw(check.params) ?? {},
  };
}

function countByStatus(checks: { status: string | null }[]) {
  const counts: Record<string, number> = { ok: 0, warn: 0, critical: 0, neutral: 0 };
  for (const check of checks) {
    const status = check.status ?? "neutral";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export const merqoHealth = defineTool({
  name: "merqo_health",
  title: "Merqo compliance and health status",
  description:
    "Read the Merqo Hub status page: compliance traffic lights (e-invoicing out and in, packaging " +
    "reporting, accessibility statement, AI labelling, review transparency) and operational health " +
    "(disabled resilience guards, overdue scheduled tasks, message queue depth, admin two-factor " +
    "coverage). Each entry is ok, warn, critical or neutral, where neutral means the area is not " +
    "covered by an installed plugin. Use it to answer 'is the shop compliant and healthy?' in one " +
    "call. Read-only. Returns one object.",
  inputSchema: {
    status: z
      .array(z.enum(CHECK_STATUS))
      .optional()
      .describe("Only return checks with these statuses, e.g. ['warn','critical']"),
  },
  handler: async (input, ctx) => {
    const body = await ctx.client.request<Raw>("/api/_action/merqo-hub/status");
    const wanted = input.status ? new Set<string>(input.status) : null;
    const keep = (check: { status: string | null }) => !wanted || wanted.has(check.status ?? "");
    const compliance = rawList(body.compliance).map(mapCheck);
    const operations = rawList(body.operations).map(mapCheck);
    return {
      generatedAt: str(body.generatedAt),
      shopwareVersion: str(body.shopware),
      phpVersion: str(body.php),
      plugins: rawList(body.merqoPlugins).map((plugin) => ({
        name: str(plugin.name),
        version: str(plugin.version),
        active: bool(plugin.active),
      })),
      summary: {
        compliance: countByStatus(compliance),
        operations: countByStatus(operations),
      },
      compliance: compliance.filter(keep),
      operations: operations.filter(keep),
    };
  },
});

export const merqoEinvoiceInbox = defineTool({
  name: "merqo_einvoice_inbox",
  title: "Merqo incoming e-invoices",
  description:
    "Search incoming supplier e-invoices archived by Merqo Vault, with their EN 16931 validation " +
    "verdict (valid, warning, error), issuing party, invoice number, date and gross total. Use it " +
    "for 'which incoming invoices failed validation?'. The archived original file is never " +
    "returned. Returns { total, page, limit, items[] }.",
  inputSchema: {
    ...searchInputShape,
    verdict: z
      .enum(["valid", "warning", "error"])
      .optional()
      .describe("Only invoices with this validation verdict"),
  },
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "createdAt", order: "DESC" }],
      extraFilters: input.verdict ? [equals("verdict", input.verdict)] : [],
    });
    const result = await ctx.client.search<Raw>("merqo-vault-document", criteria);
    return toPage(result, criteria, (document) =>
      withFields(
        {
          id: str(document.id),
          filename: str(document.filename),
          verdict: str(document.verdict),
          flavor: str(document.flavor),
          invoiceNumber: str(document.invoiceNumber),
          issueDate: str(document.issueDate),
          seller: str(document.sellerName),
          buyer: str(document.buyerName),
          currency: str(document.currency),
          grossTotal: centsToAmount(document.grossTotalCents),
          findings: document.findings ?? null,
          source: str(document.source),
          receivedAt: str(document.createdAt),
        },
        document,
        input.fields,
      ),
    );
  },
});

export const merqoReturns = defineTool({
  name: "merqo_returns_search",
  title: "Merqo returns",
  description:
    "Search customer returns filed through the Merqo Returns self-service portal, with status, " +
    "requested and refunded dates, refund total, tracking number and the returned line items. " +
    "Use it for 'which returns are still open?' or 'what was refunded last month?'. " +
    "Returns { total, page, limit, items[] }.",
  inputSchema: {
    ...searchInputShape,
    status: z.string().min(1).optional().describe("Only returns in this workflow status"),
  },
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "requestedAt", order: "DESC" }],
      extraFilters: input.status ? [equals("status", input.status)] : [],
      associations: associations(["lineItems", "order"]),
    });
    const result = await ctx.client.search<Raw>("merqo-return", criteria);
    return toPage(result, criteria, (entry) =>
      withFields(
        {
          id: str(entry.id),
          status: str(entry.status),
          orderId: str(entry.orderId),
          orderNumber: str(raw(entry.order)?.orderNumber),
          customerId: str(entry.customerId),
          refundTotal: centsToAmount(entry.refundTotalCents),
          trackingNumber: str(entry.trackingNumber),
          rejectionReason: str(entry.rejectionReason),
          requestedAt: str(entry.requestedAt),
          approvedAt: str(entry.approvedAt),
          refundedAt: str(entry.refundedAt),
          closedAt: str(entry.closedAt),
          lineItems: rawList(entry.lineItems).map((item) => ({
            id: str(item.id),
            orderLineItemId: str(item.orderLineItemId),
            quantity: num(item.quantity),
            reason: str(item.reason),
            condition: str(item.itemCondition),
          })),
        },
        entry,
        input.fields,
      ),
    );
  },
});

export const merqoAbandonedCarts = defineTool({
  name: "merqo_abandoned_carts",
  title: "Merqo abandoned carts",
  description:
    "Search abandoned cart snapshots captured by Merqo Rescue, with customer email, cart value, " +
    "line items, state and the times of last activity, abandonment and recovery. Use it for " +
    "'how much revenue is sitting in abandoned carts this week?'. The cart token is never " +
    "returned, so recovery links must come from the shop itself. " +
    "Returns { total, page, limit, items[] }.",
  inputSchema: {
    ...searchInputShape,
    state: z.string().min(1).optional().describe("Only snapshots in this state, e.g. 'abandoned'"),
  },
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "lastActivityAt", order: "DESC" }],
      extraFilters: input.state ? [equals("state", input.state)] : [],
    });
    const result = await ctx.client.search<Raw>("merqo-cart-snapshot", criteria);
    return toPage(result, criteria, (snapshot) =>
      withFields(
        {
          id: str(snapshot.id),
          email: str(snapshot.email),
          customerId: str(snapshot.customerId),
          salesChannelId: str(snapshot.salesChannelId),
          amount: num(snapshot.amount),
          state: str(snapshot.state),
          lineItems: rawList(snapshot.lineItems).map((item) => ({
            label: str(item.label) ?? str(item.name),
            quantity: num(item.quantity),
            price: num(item.price),
          })),
          lastActivityAt: str(snapshot.lastActivityAt),
          abandonedAt: str(snapshot.abandonedAt),
          recoveredAt: str(snapshot.recoveredAt),
        },
        snapshot,
        input.fields,
      ),
    );
  },
});

function centsToAmount(value: unknown): number | null {
  const cents = num(value);
  return cents === null ? null : Math.round(cents) / 100;
}

export const merqoPack: ExtensionPack = {
  id: "merqo",
  label: "Merqo",
  url: "https://github.com/bnymnDev/merqo",
  tools: [
    { requires: ["MerqoHub"], tool: merqoHealth },
    { requires: ["MerqoVault"], tool: merqoEinvoiceInbox },
    { requires: ["MerqoReturns"], tool: merqoReturns },
    { requires: ["MerqoRescue"], tool: merqoAbandonedCarts },
  ],
};
