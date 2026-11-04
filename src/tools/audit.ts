import { z } from "zod";
import { STOREFRONT_TYPE_ID } from "../client/constants.js";
import { associations, equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import { INHERITANCE_HEADERS, type Raw, type ShopwareClient } from "../client/index.js";
import { badRequest, ShopwareMcpError } from "../errors.js";
import { buildStockForecast } from "./forecast.js";
import { mapOrderSummary } from "./orders.js";
import { DAY_MS, notCancelled } from "./periods.js";
import { type ExtensionInfo, listExtensions } from "./plugins.js";
import { mapProductSummary } from "./products.js";
import { mapPromotion } from "./promotions.js";
import { checkPromotions } from "./promotions-check.js";
import { comparedWeeks, computePulse, defaultTimeZone, isTimeZone, type Pulse } from "./pulse.js";
import { mapReview, REVIEW_ASSOCIATIONS } from "./reviews.js";
import { mapSalesChannel } from "./sales-channels.js";
import { raw, str, translated } from "./shared.js";
import { fetchShopInfo } from "./shop.js";
import { listScheduledTasks } from "./tasks.js";
import { defineTool } from "./types.js";

type Severity = "critical" | "warning" | "info";

/**
 * Duties that apply to shops selling into the EU, and the kind of extension that usually covers
 * them. Detection is a name match over installed extensions, so it can only ever say whether
 * something plausible is installed. It names no product and recommends none.
 */
interface Duty {
  id: string;
  duty: string;
  applies: string;
  pattern: RegExp;
}

const EU_DUTIES: Duty[] = [
  {
    id: "e_invoicing",
    duty: "Send and receive structured e-invoices (EN 16931, XRechnung or ZUGFeRD)",
    applies:
      "Germany: receiving has been mandatory for B2B since 2025, sending follows in 2027 for " +
      "businesses above 800k EUR turnover and in 2028 for the rest",
    pattern: /x-?rechnung|zugferd|factur-?x|e-?invoic|e-?rechnung|en\s?16931|peppol/i,
  },
  {
    id: "accessibility",
    duty: "Accessible storefront and an accessibility statement",
    applies:
      "EU Accessibility Act, in Germany the BFSG, applies to consumer-facing online shops since " +
      "28 June 2025",
    pattern: /accessib|barrierefrei|wcag|bfsg/i,
  },
  {
    id: "packaging_epr",
    duty: "Report packaging volumes placed on the market",
    applies: "EU extended producer responsibility, in Germany registration and reporting via LUCID",
    pattern: /packag|verpack|lucid|epr\b|recycl/i,
  },
  {
    id: "ai_transparency",
    duty: "Label AI generated content",
    applies: "EU AI Act Article 50 transparency obligations apply from 2 August 2026",
    pattern: /\bai\b|k-?i-?kennzeich|artificial.intelligence/i,
  },
];

/** Pages a storefront selling to consumers in Germany is expected to link. */
const LEGAL_PAGES = [
  { key: "imprintPage", label: "imprint" },
  { key: "tosPage", label: "terms and conditions" },
  { key: "privacyPage", label: "privacy policy" },
  { key: "revocationPage", label: "revocation policy" },
  { key: "shippingPaymentInfoPage", label: "shipping and payment information" },
] as const;

export interface DutyCoverage {
  id: string;
  duty: string;
  applies: string;
  /** null when the extension list could not be read. */
  covered: boolean | null;
  detectedExtensions: string[];
  /** What the shop's own configuration says, where Shopware itself covers the duty. */
  notes?: string[];
}

const ZUGFERD_TYPES = ["zugferd_invoice", "zugferd_embedded_invoice"];

/**
 * Shopware 6.7 creates ZUGFeRD e-invoices itself, once a document configuration for them exists
 * and the seller's VAT ID or tax number is filled in. Older versions need an extension.
 */
export async function eInvoiceReadiness(client: ShopwareClient) {
  const [types, configs] = await Promise.all([
    client.search<Raw>("document-type", {
      page: 1,
      limit: 10,
      filter: [equalsAny("technicalName", [...ZUGFERD_TYPES, "invoice"])],
      includes: { document_type: ["id", "technicalName"] },
    }),
    client.search<Raw>("document-base-config", {
      page: 1,
      limit: 50,
      associations: associations(["documentType"]),
      includes: {
        document_base_config: ["id", "global", "config", "documentType"],
        document_type: ["technicalName"],
      },
    }),
  ]);
  const technical = (entry: Raw) => str(raw(entry.documentType)?.technicalName);
  const core = types.items.some((type) => ZUGFERD_TYPES.includes(str(type.technicalName) ?? ""));
  const configured = configs.items.some((config) =>
    ZUGFERD_TYPES.includes(technical(config) ?? ""),
  );
  const sellerIds = configs.items
    .filter((config) => [...ZUGFERD_TYPES, "invoice"].includes(technical(config) ?? ""))
    .some((config) => {
      const values = raw(config.config) ?? {};
      return [values.vatId, values.taxNumber].some(
        (value) => typeof value === "string" && value.trim() !== "",
      );
    });
  const notes: string[] = [];
  if (!core) {
    notes.push(
      "This Shopware version cannot create e-invoices itself (ZUGFeRD arrived in 6.7); an extension is needed",
    );
  } else if (!configured) {
    notes.push(
      "Shopware can create ZUGFeRD e-invoices, but no document configuration for them exists yet (Settings → Shop → Documents)",
    );
  }
  if (!sellerIds) {
    notes.push(
      "The invoice configuration has neither a VAT ID nor a tax number; an e-invoice needs one",
    );
  }
  return { core, configured, sellerIds, notes };
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  /** Total number of affected records (items[] is capped by maxItems). */
  count: number;
  items: unknown[];
  hint: string;
}

const ORDER_ASSOCIATIONS = associations([
  "orderCustomer",
  "currency",
  "stateMachineState",
  "transactions.stateMachineState",
  "deliveries.stateMachineState",
]);
const PRODUCT_ASSOCIATIONS = associations(["manufacturer", "categories", "cover.media"]);

/** Simple products and variants only; configurator parents carry no meaningful stock. */
const NO_CHILDREN: ShopwareFilter = {
  type: "multi",
  operator: "or",
  queries: [equals("childCount", 0), equals("childCount", null)],
};

interface Check {
  id: string;
  severity: Severity;
  title: string;
  hint: string;
  /**
   * A privilege least-privilege setups leave out on purpose. Refused for lack of it, the
   * check is reported as not covered instead of failed.
   */
  privilege?: string;
  run(): Promise<{ count: number; items: unknown[] }>;
}

const refused = (privilege: string) =>
  new ShopwareMcpError(403, "MISSING_PRIVILEGE", `the integration lacks ${privilege}`);

export interface AuditInput {
  stuckOrderDays: number;
  lowStockThreshold: number;
  forecastDays: number;
  maxItems: number;
  complianceChecks: boolean;
  /** The shop's time zone for "the same hours on the same weekday"; default: the server's. */
  timeZone?: string;
  /** A pulse computed already (the brief has one), so the silence check does not repeat it. */
  pulse?: Pulse;
}

function dutyCoverage(
  extensions: ExtensionInfo[] | null,
  eInvoice: Awaited<ReturnType<typeof eInvoiceReadiness>> | null,
): DutyCoverage[] {
  return EU_DUTIES.map(({ id, duty, applies, pattern }) => {
    const notes = id === "e_invoicing" && eInvoice ? { notes: eInvoice.notes } : {};
    const native =
      id === "e_invoicing" && eInvoice?.core && eInvoice.configured && eInvoice.sellerIds;
    if (!extensions) {
      return { id, duty, applies, covered: native ? true : null, detectedExtensions: [], ...notes };
    }
    const hits = extensions
      .filter(
        (extension) =>
          extension.active && (pattern.test(extension.name) || pattern.test(extension.label ?? "")),
      )
      .map((extension) => extension.name);
    if (native) hits.unshift("Shopware (ZUGFeRD)");
    return { id, duty, applies, covered: hits.length > 0, detectedExtensions: hits, ...notes };
  });
}

export async function runAudit(client: ShopwareClient, input: AuditInput) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - input.stuckOrderDays * DAY_MS).toISOString();
  const limit = input.maxItems;
  const currencies = await client.currencies().catch(() => null);
  // One extension lookup serves both the update check and the duty coverage map.
  const extensionList = listExtensions(client).catch(() => null);
  const extensions = extensionList.then((result) => result?.items ?? null);

  const orderCheck = (filter: ShopwareFilter[]) => async () => {
    const result = await client.search<Raw>("order", {
      page: 1,
      limit,
      filter,
      sort: [{ field: "orderDateTime", order: "ASC" }],
      associations: ORDER_ASSOCIATIONS,
    });
    return { count: result.total, items: result.items.map(mapOrderSummary) };
  };

  const productCheck =
    (filter: ShopwareFilter[], sortField = "stock") =>
    async () => {
      const result = await client.search<Raw>(
        "product",
        {
          page: 1,
          limit,
          filter,
          sort: [{ field: sortField, order: "ASC" }],
          associations: PRODUCT_ASSOCIATIONS,
        },
        INHERITANCE_HEADERS,
      );
      return {
        count: result.total,
        items: result.items.map((product) => mapProductSummary(product, currencies)),
      };
    };

  const checks: Check[] = [
    {
      id: "orders_paid_not_shipped",
      severity: "critical",
      title: `Paid orders not shipped for more than ${input.stuckOrderDays} days`,
      hint:
        "Ship or communicate a delay; these customers have already paid. Matched on any paid " +
        "transaction, so an order refunded later can appear here too.",
      run: orderCheck([
        equalsAny("stateMachineState.technicalName", ["open", "in_progress"]),
        equals("transactions.stateMachineState.technicalName", "paid"),
        equalsAny("deliveries.stateMachineState.technicalName", ["open"]),
        { type: "range", field: "orderDateTime", parameters: { lt: cutoff } },
      ]),
    },
    {
      id: "orders_unpaid_old",
      severity: "warning",
      title: `Open orders unpaid for more than ${input.stuckOrderDays} days`,
      hint: "Send a payment reminder or cancel to free reserved stock.",
      run: orderCheck([
        equals("stateMachineState.technicalName", "open"),
        equalsAny("transactions.stateMachineState.technicalName", [
          "open",
          "reminded",
          "in_progress",
        ]),
        { type: "range", field: "orderDateTime", parameters: { lt: cutoff } },
      ]),
    },
    {
      id: "orders_shipped_not_completed",
      severity: "info",
      title: `Orders paid and shipped but not completed for more than ${input.stuckOrderDays} days`,
      hint: "Complete them (order_state_transition: complete) so open-order lists show real work only.",
      run: orderCheck([
        equalsAny("stateMachineState.technicalName", ["open", "in_progress"]),
        equals("transactions.stateMachineState.technicalName", "paid"),
        equals("deliveries.stateMachineState.technicalName", "shipped"),
        { type: "range", field: "orderDateTime", parameters: { lt: cutoff } },
      ]),
    },
    {
      id: "orders_paid_without_invoice",
      severity: "warning",
      title: `Paid orders older than ${input.stuckOrderDays} days without an invoice document`,
      hint:
        "Every paid order needs an invoice for the books; order_document_create with type " +
        "invoice generates it from Shopware's own template. Cancelled orders are not counted.",
      run: orderCheck([
        equals("transactions.stateMachineState.technicalName", "paid"),
        notCancelled(),
        {
          type: "not",
          operator: "and",
          queries: [equals("documents.documentType.technicalName", "invoice")],
        },
        { type: "range", field: "orderDateTime", parameters: { lt: cutoff } },
      ]),
    },
    {
      id: "products_running_out",
      severity: "warning",
      title: `Products that run out within ${input.forecastDays} days at the current sales pace`,
      hint:
        "Reorder them; suggestedReorder keeps each product in stock for the horizon plus 30 " +
        "days at the pace of the last 30 days. stock_forecast has the full list and other horizons.",
      run: async () => {
        const forecast = await buildStockForecast(client, {
          days: 30,
          horizon: input.forecastDays,
          restockDays: 30,
          limit,
        });
        return { count: forecast.total, items: forecast.items };
      },
    },
    {
      id: "products_out_of_stock",
      severity: "warning",
      title: "Active products with zero or negative stock",
      hint: "Restock, deactivate, or mark as closeout so they stop being orderable.",
      run: productCheck([
        equals("active", true),
        NO_CHILDREN,
        { type: "range", field: "stock", parameters: { lte: 0 } },
      ]),
    },
    {
      id: "products_low_stock",
      severity: "warning",
      title: `Active products with stock below ${input.lowStockThreshold}`,
      hint: "Reorder soon; sorted by lowest stock first.",
      run: productCheck([
        equals("active", true),
        NO_CHILDREN,
        { type: "range", field: "stock", parameters: { gt: 0, lt: input.lowStockThreshold } },
      ]),
    },
    {
      id: "products_missing_cover",
      severity: "info",
      title: "Active products without a cover image",
      hint: "Products without images convert poorly; upload a cover image.",
      run: productCheck(
        [equals("active", true), NO_CHILDREN, equals("coverId", null)],
        "productNumber",
      ),
    },
    {
      id: "promotions_expired_active",
      severity: "warning",
      title: "Promotions still active after their end date",
      hint: "Deactivate them (promotion_toggle) to keep the promotion list clean.",
      run: async () => {
        const result = await client.search<Raw>("promotion", {
          page: 1,
          limit,
          filter: [
            equals("active", true),
            { type: "range", field: "validUntil", parameters: { lt: now.toISOString() } },
          ],
          sort: [{ field: "validUntil", order: "ASC" }],
          associations: associations(["discounts"]),
        });
        return { count: result.total, items: result.items.map(mapPromotion) };
      },
    },
    {
      id: "promotions_broken",
      severity: "warning",
      title: "Promotions in the next 14 days that will not work",
      hint:
        "promotions_check shows every finding per promotion; fix them before the campaign, " +
        "since a broken code is only noticed when customers complain.",
      run: async () => {
        const check = await checkPromotions(client, {
          until: new Date(now.getTime() + 14 * DAY_MS),
          now,
        });
        const broken = check.promotions.filter((promotion) =>
          promotion.findings.some((finding) => finding.severity === "critical"),
        );
        return {
          count: broken.length,
          items: broken.slice(0, limit).map((promotion) => ({
            label: promotion.name,
            id: promotion.id,
            problems: promotion.findings
              .filter((finding) => finding.severity === "critical")
              .map((finding) => finding.problem),
          })),
        };
      },
    },
    {
      id: "sales_channels_maintenance",
      severity: "critical",
      title: "Sales channels in maintenance mode",
      hint: "Customers see a maintenance page; disable it once work is done.",
      run: async () => {
        const result = await client.search<Raw>("sales-channel", {
          page: 1,
          limit,
          filter: [equals("maintenance", true)],
          associations: associations(["domains", "type"]),
        });
        return { count: result.total, items: result.items.map(mapSalesChannel) };
      },
    },
    {
      id: "legal_pages_missing",
      severity: "warning",
      title: "Storefronts without all legal pages assigned",
      hint:
        "Assign imprint, terms, privacy, revocation and shipping pages under Settings → Basic " +
        "information, per sales channel where they differ. Missing ones invite warning letters " +
        "in Germany.",
      privilege: "system_config:read",
      run: async () => {
        const channels = await client.search<Raw>("sales-channel", {
          page: 1,
          limit: 50,
          filter: [equals("active", true), equals("typeId", STOREFRONT_TYPE_ID)],
          includes: { sales_channel: ["id", "name", "translated", "typeId", "active"] },
        });
        const storefronts = channels.items.filter(
          (channel) => channel.typeId === STOREFRONT_TYPE_ID && channel.active !== false,
        );
        const items: Array<{
          salesChannelId: string;
          salesChannel: string | null;
          missing: string[];
        }> = [];
        for (const channel of storefronts) {
          const id = typeof channel.id === "string" ? channel.id : null;
          if (!id) continue;
          const config = await client.request<Raw>(
            `/api/_action/system-config?domain=core.basicInformation&salesChannelId=${id}&inherit=1`,
          );
          const missing = LEGAL_PAGES.filter(
            ({ key }) => typeof config[`core.basicInformation.${key}`] !== "string",
          ).map(({ label }) => label);
          if (missing.length > 0) {
            items.push({ salesChannelId: id, salesChannel: translated(channel, "name"), missing });
          }
        }
        return { count: items.length, items: items.slice(0, limit) };
      },
    },
    {
      id: "products_without_delivery_time",
      severity: "info",
      title: "Active products without a delivery time",
      hint:
        "German price regulations expect a stated delivery time; assign one under the product's " +
        "deliverability settings.",
      run: productCheck(
        [equals("active", true), NO_CHILDREN, equals("deliveryTimeId", null)],
        "productNumber",
      ),
    },
    {
      id: "products_not_visible",
      severity: "info",
      title: "Active products not visible in any sales channel",
      hint:
        "They exist but no storefront lists them; assign a sales channel visibility " +
        "(product_create does this via salesChannelIds) or deactivate them.",
      run: productCheck(
        [equals("active", true), NO_CHILDREN, equals("visibilities.id", null)],
        "productNumber",
      ),
    },
    {
      id: "reviews_pending",
      severity: "info",
      title: "Product reviews awaiting moderation",
      hint: "Approve or hide them with review_moderate; unanswered reviews age badly.",
      run: async () => {
        const result = await client.search<Raw>("product-review", {
          page: 1,
          limit,
          filter: [equals("status", false)],
          sort: [{ field: "createdAt", order: "ASC" }],
          associations: REVIEW_ASSOCIATIONS,
        });
        return { count: result.total, items: result.items.map(mapReview) };
      },
    },
    {
      id: "scheduled_tasks_stuck",
      severity: "warning",
      title: "Scheduled tasks overdue by more than an hour, failed or stuck running",
      hint:
        "The scheduler or the message worker is not running: search indexes, thumbnails and " +
        "mails wait with it. Check the cron or worker; scheduled_tasks_list has the details.",
      run: async () => {
        const result = await listScheduledTasks(client, 60);
        return { count: result.problems.length, items: result.problems.slice(0, limit) };
      },
    },
    {
      id: "plugins_outdated",
      severity: "info",
      title: "Extensions with an available update",
      hint: "Review changelogs and update in a staging environment first.",
      privilege: "system.plugin_maintain",
      run: async () => {
        const result = await extensionList;
        if (!result) throw new ShopwareMcpError(0, "UNAVAILABLE", "extension list unavailable");
        // Without the update list every extension would look current; say so instead.
        if (result.updatesRefused) throw refused("system.plugin_maintain");
        const items = result.items;
        const outdated = items.filter((item) => item.installed && item.upgradeVersion);
        return { count: outdated.length, items: outdated.slice(0, limit) };
      },
    },
    {
      id: "checkout_silent",
      severity: "critical",
      title: "No orders for an unusually long time",
      hint:
        "The same hours of recent weeks brought orders, so this quiet spell is unlikely to be " +
        "chance. Check the checkout: checkout_simulate shows what a customer sees, then " +
        "maintenance mode, the payment provider and the error log.",
      run: async () => {
        const pulse =
          input.pulse ??
          (await computePulse(client, {
            weeks: 8,
            timeZone: input.timeZone ?? defaultTimeZone(),
            now,
          }));
        const silence = pulse.silence;
        if (silence?.verdict !== "unusual") return { count: 0, items: [] };
        return {
          count: 1,
          items: [
            {
              label:
                `Last order #${pulse.lastOrder?.orderNumber ?? "?"} ${silence.minutes} minutes ago; ` +
                `the same hours of ${comparedWeeks(pulse, "week")} brought ${silence.expectedOrders} on average`,
              lastOrder: pulse.lastOrder?.orderNumber ?? null,
              lastOrderAt: pulse.lastOrder?.at ?? null,
              minutesWithoutOrder: silence.minutes,
              expectedOrders: silence.expectedOrders,
              chance: silence.chance,
            },
          ],
        };
      },
    },
  ];

  const warnings: string[] = [];
  const notCovered: string[] = [];
  const settled = await Promise.allSettled(checks.map((check) => check.run()));
  const findings: Finding[] = [];
  settled.forEach((result, index) => {
    const check = checks[index];
    if (!check) return;
    if (result.status === "rejected") {
      const reason = result.reason;
      if (check.privilege && reason instanceof ShopwareMcpError && reason.status === 403) {
        notCovered.push(`${check.id} (needs ${check.privilege})`);
        return;
      }
      const detail =
        reason instanceof ShopwareMcpError ? `${reason.code}: ${reason.detail}` : String(reason);
      warnings.push(`${check.id} skipped (${detail})`);
      return;
    }
    if (result.value.count === 0) return;
    findings.push({
      id: check.id,
      severity: check.severity,
      title: check.title,
      count: result.value.count,
      items: result.value.items,
      hint: check.hint,
    });
  });

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);

  const shop = await fetchShopInfo(client).catch(() => null);
  const summary = {
    critical: findings.filter((finding) => finding.severity === "critical").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    checksRun: checks.length - warnings.length - notCovered.length,
    healthy: findings.every((finding) => finding.severity === "info"),
  };

  const compliance = input.complianceChecks
    ? {
        scope:
          "Duties for shops selling into the EU. Coverage is guessed from the names of installed " +
          "extensions, so it shows whether something plausible is installed, not whether the shop " +
          "is compliant. Not legal advice.",
        items: dutyCoverage(await extensions, await eInvoiceReadiness(client).catch(() => null)),
      }
    : undefined;

  return {
    generatedAt: now.toISOString(),
    shop: shop ? { url: shop.url, version: shop.version, edition: shop.edition } : null,
    parameters: {
      stuckOrderDays: input.stuckOrderDays,
      lowStockThreshold: input.lowStockThreshold,
      forecastDays: input.forecastDays,
      maxItems: input.maxItems,
      complianceChecks: input.complianceChecks,
    },
    summary,
    findings,
    ...(compliance ? { compliance } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(notCovered.length > 0 ? { notCovered } : {}),
  };
}

export const shopAudit = defineTool({
  name: "shop_audit",
  title: "Shop health audit",
  description:
    "Run a one-shot health check across the shop and return prioritised findings: paid orders " +
    "not shipped, old unpaid orders, shipped orders never completed, out-of-stock and low-stock " +
    "products, products without cover image, delivery time or sales channel visibility, " +
    "expired promotions still active, promotions in the next 14 days that will not work, sales " +
    "channels in maintenance mode, storefronts missing " +
    "legal pages (imprint, terms, privacy, revocation, shipping), reviews awaiting moderation, " +
    "scheduled tasks overdue or failed, and extensions with pending updates. Each finding has a " +
    "severity, total count, sample items and a hint. " +
    "Also reports which EU duties (e-invoicing, accessibility, packaging reporting, AI " +
    "labelling) appear to be covered by an installed extension, guessed from extension names, " +
    "and whether Shopware itself is set up for ZUGFeRD e-invoices. " +
    "Start here when asked 'is everything okay with the shop?'. Read-only. Returns one object.",
  inputSchema: {
    stuckOrderDays: z.number().int().min(1).max(365).default(7),
    lowStockThreshold: z.number().int().min(1).max(10_000).default(5),
    forecastDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(14)
      .describe("Flag products whose stock lasts fewer days than this at the recent sales pace"),
    maxItems: z.number().int().min(1).max(50).default(10).describe("Sample items per finding"),
    complianceChecks: z
      .boolean()
      .default(true)
      .describe("Include the EU duty coverage map. Set false outside the EU."),
    timeZone: z
      .string()
      .trim()
      .optional()
      .describe("IANA time zone of the shop for the order-silence check; default: the server's"),
  },
  handler: (input, ctx) => {
    if (input.timeZone && !isTimeZone(input.timeZone)) {
      throw badRequest(`Unknown time zone "${input.timeZone}"`);
    }
    return runAudit(ctx.client, input);
  },
});
