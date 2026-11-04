import { STOREFRONT_TYPE_ID } from "./client/constants.js";
import { equals } from "./client/criteria.js";
import type { Raw } from "./client/index.js";
import { notCancelled } from "./tools/periods.js";
import { raw, rawList, str } from "./tools/shared.js";
import { checkoutSimulate } from "./tools/storefront.js";
import { listScheduledTasks } from "./tools/tasks.js";
import { defineTool, type ToolContext } from "./tools/types.js";

const HOUR_MS = 3_600_000;

export interface Diagnosis {
  /** One plain sentence per likely cause, most telling first. */
  causes: string[];
  /** Things that were looked at and found fine, so nobody checks them twice. */
  fine: string[];
}

/** Run one look and never let it sink the others: a refused read just leaves a gap. */
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/**
 * The usual suspects when orders stop, looked at in one go: a channel in maintenance, a test
 * purchase of today's best seller, extensions installed or updated in the last day, errors in
 * Shopware's log in the last hours, and scheduled tasks that stopped running.
 */
export async function diagnose(ctx: ToolContext, now: Date = new Date()): Promise<Diagnosis> {
  const { client } = ctx;
  const causes: string[] = [];
  const fine: string[] = [];
  const since = (hours: number) => new Date(now.getTime() - hours * HOUR_MS).toISOString();

  const [channels, bestSeller, plugins, errors, tasks] = await Promise.all([
    attempt(() =>
      client.search<Raw>("sales-channel", {
        page: 1,
        limit: 50,
        filter: [equals("typeId", STOREFRONT_TYPE_ID)],
        includes: { sales_channel: ["id", "name", "translated", "active", "maintenance"] },
      }),
    ),
    attempt(async () => {
      const items = await client.search<Raw>("order-line-item", {
        page: 1,
        limit: 1,
        "total-count-mode": 0,
        filter: [
          equals("type", "product"),
          { type: "range", field: "order.orderDateTime", parameters: { gte: since(24 * 14) } },
          notCancelled("order."),
        ],
        includes: { order_line_item: ["id"] },
        aggregations: [
          {
            name: "top",
            type: "terms",
            field: "product.productNumber",
            limit: 1,
            sort: { field: "_count", order: "DESC" },
          },
        ],
      });
      return str(rawList(raw(items.aggregations.top)?.buckets)[0]?.key);
    }),
    attempt(() =>
      client.search<Raw>("plugin", {
        page: 1,
        limit: 10,
        filter: [
          {
            type: "multi",
            operator: "or",
            queries: [
              { type: "range", field: "installedAt", parameters: { gte: since(24) } },
              { type: "range", field: "upgradedAt", parameters: { gte: since(24) } },
            ],
          },
        ],
        includes: { plugin: ["name", "version", "active", "installedAt", "upgradedAt"] },
      }),
    ),
    attempt(() =>
      client.search<Raw>("log-entry", {
        page: 1,
        limit: 5,
        "total-count-mode": 1,
        filter: [
          { type: "range", field: "level", parameters: { gte: 400 } },
          { type: "range", field: "createdAt", parameters: { gte: since(6) } },
        ],
        sort: [{ field: "createdAt", order: "DESC" }],
        includes: { log_entry: ["message", "channel", "level", "createdAt", "context"] },
        aggregations: [{ name: "messages", type: "terms", field: "message", limit: 5 }],
      }),
    ),
    attempt(() => listScheduledTasks(client, 60, now)),
  ]);

  if (channels) {
    const down = channels.items.filter(
      (channel) => channel.active === false || channel.maintenance === true,
    );
    for (const channel of down) {
      const name = str(raw(channel.translated)?.name) ?? str(channel.name) ?? "a storefront";
      causes.push(
        channel.maintenance === true
          ? `${name} is in maintenance mode: customers see the maintenance page`
          : `${name} is inactive`,
      );
    }
    if (down.length === 0 && channels.items.length > 0) fine.push("every storefront is open");
  }

  if (bestSeller) {
    const purchase = await attempt(() =>
      checkoutSimulate.handler({ items: [{ productNumber: bestSeller, quantity: 1 }] }, ctx),
    );
    if (purchase) {
      const blocking = purchase.problems.filter((problem) => problem.blocksOrder);
      if (!purchase.canOrder) {
        const why = blocking.map(
          (problem) => problem.explanation ?? problem.message ?? problem.key,
        );
        causes.push(
          `A test purchase of the best seller ${bestSeller} fails: ${why.join("; ") || "cannot order"}`,
        );
      } else {
        const offered = purchase.paymentMethods?.available ?? [];
        const hidden = purchase.paymentMethods?.hidden ?? [];
        fine.push(
          `a test purchase of ${bestSeller} works, payment: ${offered.join(", ") || "none"}` +
            (hidden.length > 0
              ? `; hidden: ${hidden.map((entry) => `${entry.name} (${entry.reason})`).join(", ")}`
              : ""),
        );
      }
    }
  }

  if (plugins && plugins.items.length > 0) {
    const changed = plugins.items.map((plugin) => {
      const upgraded = str(plugin.upgradedAt);
      const at = upgraded ?? str(plugin.installedAt) ?? "";
      const hours = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / HOUR_MS));
      return `${str(plugin.name)} ${upgraded ? "updated" : "installed"} ${hours} h ago (${str(plugin.version) ?? "?"})`;
    });
    causes.push(`Extensions changed in the last 24 hours: ${changed.join(", ")}`);
  }

  if (errors) {
    if (errors.total > 0) {
      const messages = rawList(raw(errors.aggregations.messages)?.buckets)
        .map((bucket) => `${str(bucket.key)} (${bucket.count})`)
        .join(", ");
      const detail = str(raw(raw(errors.items[0]?.context)?.additionalData)?.message);
      causes.push(
        `${errors.total} errors in Shopware's log in the last 6 hours: ${messages}` +
          (detail ? `. Latest: ${detail.slice(0, 160)}` : ""),
      );
    } else {
      fine.push("no errors in Shopware's log in the last 6 hours");
    }
  }

  if (tasks) {
    if (tasks.problems.length > 0) {
      causes.push(
        `${tasks.problems.length} scheduled tasks are overdue or failed, e.g. ${tasks.problems
          .slice(0, 2)
          .map((task) => task.name)
          .join(", ")}: the worker or cron may be down`,
      );
    } else {
      fine.push("scheduled tasks run on time");
    }
  }

  return { causes, fine };
}

/** The diagnosis as a few lines for Slack or a terminal. */
export function diagnosisText(diagnosis: Diagnosis): string {
  const lines: string[] = [];
  if (diagnosis.causes.length > 0) {
    lines.push("*Likely causes*", ...diagnosis.causes.map((cause) => `• ${cause}`));
  } else {
    lines.push(
      "No obvious cause found: check the payment provider's status page and the error log.",
    );
  }
  if (diagnosis.fine.length > 0) lines.push(`_Looked fine: ${diagnosis.fine.join("; ")}._`);
  return lines.join("\n");
}

export const shopDiagnose = defineTool({
  name: "shop_diagnose",
  title: "Why are orders not coming in?",
  description:
    "Look at the usual suspects in one call when orders stop or customers complain: storefronts " +
    "in maintenance or inactive, a test purchase of the best seller of the last two weeks with " +
    "the payment methods really offered, extensions installed or updated in the last 24 hours, " +
    "errors in Shopware's log in the last 6 hours (failed mails included), and scheduled tasks " +
    "that stopped. Nothing is ordered. Returns { causes[], fine[] }: likely causes first, and " +
    "what was checked and found fine.",
  annotations: { idempotentHint: false },
  inputSchema: {},
  handler: (_input, ctx) => diagnose(ctx),
});
