import { z } from "zod";
import { associations, equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import { INHERITANCE_HEADERS, type Raw, type ShopwareClient } from "../client/index.js";
import { ShopwareMcpError } from "../errors.js";
import { mapOrderSummary } from "./orders.js";
import { type ExtensionInfo, listExtensions } from "./plugins.js";
import { mapProductSummary } from "./products.js";
import { mapPromotion } from "./promotions.js";
import { mapSalesChannel } from "./sales-channels.js";
import { fetchShopInfo } from "./shop.js";
import { defineTool } from "./types.js";

const DAY_MS = 86_400_000;

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

export interface DutyCoverage {
  id: string;
  duty: string;
  applies: string;
  /** null when the extension list could not be read. */
  covered: boolean | null;
  detectedExtensions: string[];
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
  run(): Promise<{ count: number; items: unknown[] }>;
}

export interface AuditInput {
  stuckOrderDays: number;
  lowStockThreshold: number;
  maxItems: number;
  complianceChecks: boolean;
}

function dutyCoverage(extensions: ExtensionInfo[] | null): DutyCoverage[] {
  return EU_DUTIES.map(({ id, duty, applies, pattern }) => {
    if (!extensions) return { id, duty, applies, covered: null, detectedExtensions: [] };
    const hits = extensions
      .filter(
        (extension) =>
          extension.active && (pattern.test(extension.name) || pattern.test(extension.label ?? "")),
      )
      .map((extension) => extension.name);
    return { id, duty, applies, covered: hits.length > 0, detectedExtensions: hits };
  });
}

export async function runAudit(client: ShopwareClient, input: AuditInput) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - input.stuckOrderDays * DAY_MS).toISOString();
  const limit = input.maxItems;
  const currencies = await client.currencies().catch(() => null);
  // One extension lookup serves both the update check and the duty coverage map.
  const extensions = listExtensions(client)
    .then((result) => result.items)
    .catch(() => null);

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
      hint: "Ship or communicate a delay; these customers have already paid.",
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
      id: "plugins_outdated",
      severity: "info",
      title: "Extensions with an available update",
      hint: "Review changelogs and update in a staging environment first.",
      run: async () => {
        const items = await extensions;
        if (!items) throw new ShopwareMcpError(0, "UNAVAILABLE", "extension list unavailable");
        const outdated = items.filter((item) => item.installed && item.upgradeVersion);
        return { count: outdated.length, items: outdated.slice(0, limit) };
      },
    },
  ];

  const warnings: string[] = [];
  const settled = await Promise.allSettled(checks.map((check) => check.run()));
  const findings: Finding[] = [];
  settled.forEach((result, index) => {
    const check = checks[index];
    if (!check) return;
    if (result.status === "rejected") {
      const reason = result.reason;
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
    checksRun: checks.length - warnings.length,
    healthy: findings.every((finding) => finding.severity === "info"),
  };

  const compliance = input.complianceChecks
    ? {
        scope:
          "Duties for shops selling into the EU. Coverage is guessed from the names of installed " +
          "extensions, so it shows whether something plausible is installed, not whether the shop " +
          "is compliant. Not legal advice.",
        items: dutyCoverage(await extensions),
      }
    : undefined;

  return {
    generatedAt: now.toISOString(),
    shop: shop ? { url: shop.url, version: shop.version, edition: shop.edition } : null,
    parameters: input,
    summary,
    findings,
    ...(compliance ? { compliance } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export const shopAudit = defineTool({
  name: "shop_audit",
  title: "Shop health audit",
  description:
    "Run a one-shot health check across the shop and return prioritised findings: paid orders " +
    "not shipped, old unpaid orders, out-of-stock and low-stock products, products without cover " +
    "image, expired promotions still active, sales channels in maintenance mode and extensions " +
    "with pending updates. Each finding has a severity, total count, sample items and a hint. " +
    "Also reports which EU duties (e-invoicing, accessibility, packaging reporting, AI " +
    "labelling) appear to be covered by an installed extension, guessed from extension names. " +
    "Start here when asked 'is everything okay with the shop?'. Read-only. Returns one object.",
  inputSchema: {
    stuckOrderDays: z.number().int().min(1).max(365).default(7),
    lowStockThreshold: z.number().int().min(1).max(10_000).default(5),
    maxItems: z.number().int().min(1).max(50).default(10).describe("Sample items per finding"),
    complianceChecks: z
      .boolean()
      .default(true)
      .describe("Include the EU duty coverage map. Set false outside the EU."),
  },
  handler: (input, ctx) => runAudit(ctx.client, input),
});
