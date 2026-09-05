import { associations, equals } from "./client/criteria.js";
import type { Raw, ShopwareClient } from "./client/index.js";
import { ShopwareMcpError } from "./errors.js";
import { tools } from "./tools/index.js";
import { rawList, str, strList } from "./tools/shared.js";
import { fetchShopInfo } from "./tools/shop.js";
import type { ToolContext } from "./tools/types.js";

interface Requirement {
  /** Entities the tool reads; each needs `<entity>:read` and is probed with a one-row search. */
  reads: string[];
  /** Privileges a write tool needs on top, taken from the integration's role when readable. */
  writes?: string[];
  /** Routes without an entity behind them, probed with a GET. */
  routes?: string[];
  /** Routes the tool can do without; a refusal only narrows what it reports. */
  optionalRoutes?: string[];
}

const SYSTEM_CONFIG = "/api/_action/system-config?domain=core.basicInformation";

const REQUIREMENTS: Record<string, Requirement> = {
  shop_info: { reads: ["currency", "language"], routes: ["/api/_info/version"] },
  sales_channels_list: { reads: ["sales_channel"] },
  products_search: { reads: ["product", "currency"] },
  products_get: { reads: ["product", "currency"] },
  orders_search: { reads: ["order"] },
  orders_get: { reads: ["order"] },
  order_documents_list: { reads: ["order", "document"] },
  document_download: { reads: ["document"] },
  customers_search: { reads: ["customer"] },
  customers_get: { reads: ["customer"] },
  categories_list: { reads: ["category"] },
  promotions_list: { reads: ["promotion"] },
  plugins_list: { reads: ["plugin"], optionalRoutes: ["/api/_action/extension/installed"] },
  stock_get: { reads: ["product"] },
  sales_report: { reads: ["order", "order_line_item", "product"] },
  shop_audit: {
    reads: ["order", "product", "promotion", "sales_channel", "plugin"],
    optionalRoutes: [SYSTEM_CONFIG, "/api/_action/extension/installed"],
  },
  entity_schema: { reads: [], routes: ["/api/_info/entity-schema.json"] },
  entity_search: { reads: [] },
  stock_set: { reads: ["product"], writes: ["product:update"] },
  product_update: { reads: ["product"], writes: ["product:update"] },
  order_state_transition: { reads: ["order"], writes: ["order:update"] },
  order_delivery_transition: {
    reads: ["order", "order_delivery"],
    writes: ["order_delivery:update"],
  },
  order_transaction_transition: {
    reads: ["order", "order_transaction"],
    writes: ["order_transaction:update"],
  },
  order_note: { reads: ["order"], writes: ["order:update"] },
  order_document_create: { reads: ["order", "document"], writes: ["document:create"] },
  promotion_toggle: { reads: ["promotion"], writes: ["promotion:update"] },
};

export type Readiness = "ready" | "blocked" | "unknown";

export interface ToolReadiness {
  tool: string;
  write: boolean;
  status: Readiness;
  detail: string | null;
}

export interface DoctorReport {
  shop: { url: string; version: string | null; edition: string | null } | null;
  connection: { ok: boolean; detail: string | null };
  integration: {
    label: string | null;
    admin: boolean;
    /** Privileges from the integration's roles; null when the role could not be read. */
    privileges: string[] | null;
  };
  tools: ToolReadiness[];
  /** Connection works and every read tool is ready. */
  ok: boolean;
}

type ProbeResult = { ok: true } | { ok: false; detail: string };

function describe(error: unknown): string {
  if (error instanceof ShopwareMcpError) {
    return error.status ? `${error.code} (HTTP ${error.status})` : `${error.code}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function probe(run: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: describe(error) };
  }
}

async function readIntegration(
  client: ShopwareClient,
  clientId: string,
): Promise<DoctorReport["integration"] | null> {
  try {
    const result = await client.search<Raw>("integration", {
      page: 1,
      limit: 1,
      filter: [equals("accessKey", clientId)],
      associations: associations(["aclRoles"]),
      includes: {
        integration: ["id", "label", "admin", "aclRoles"],
        acl_role: ["id", "name", "privileges"],
      },
    });
    const integration = result.items[0];
    if (!integration) return null;
    const privileges = new Set<string>();
    for (const role of rawList(integration.aclRoles)) {
      for (const privilege of strList(role.privileges)) privileges.add(privilege);
    }
    return {
      label: str(integration.label),
      admin: integration.admin === true,
      privileges: [...privileges].sort(),
    };
  } catch {
    return null;
  }
}

/**
 * Check what this integration can do before an agent finds out the hard way. Reads are probed
 * with one-row searches, so the verdict reflects Shopware's real answer; write privileges are
 * read from the integration's role when that is allowed, and reported as unknown otherwise.
 */
export async function runDoctor(ctx: ToolContext): Promise<DoctorReport> {
  const { client, config } = ctx;
  const unknownAll = (detail: string): ToolReadiness[] =>
    tools.map((tool) => ({ tool: tool.name, write: tool.write, status: "unknown", detail }));

  let shop: DoctorReport["shop"] = null;
  try {
    // fetchShopInfo tolerates partial failures; the version route must answer for a verdict.
    await client.request("/api/_info/version");
    const info = await fetchShopInfo(client);
    shop = { url: info.url, version: info.version, edition: info.edition };
  } catch (error) {
    const detail = describe(error);
    return {
      shop: null,
      connection: { ok: false, detail },
      integration: { label: null, admin: false, privileges: null },
      tools: unknownAll("shop unreachable"),
      ok: false,
    };
  }

  const integration = (await readIntegration(client, config.clientId)) ?? {
    label: null,
    admin: false,
    privileges: null,
  };

  const reads = new Map<string, ProbeResult>();
  const routes = new Map<string, ProbeResult>();
  if (!integration.admin) {
    const entities = [...new Set(Object.values(REQUIREMENTS).flatMap((r) => r.reads))];
    const paths = [
      ...new Set(
        Object.values(REQUIREMENTS).flatMap((r) => [
          ...(r.routes ?? []),
          ...(r.optionalRoutes ?? []),
        ]),
      ),
    ];
    await Promise.all([
      ...entities.map(async (entity) => {
        const result = await probe(() =>
          client.search(entity.replace(/_/g, "-"), {
            page: 1,
            limit: 1,
            includes: { [entity]: ["id"] },
          }),
        );
        reads.set(entity, result);
      }),
      ...paths.map(async (path) => {
        routes.set(path, await probe(() => client.request(path)));
      }),
    ]);
  }

  const readiness: ToolReadiness[] = tools.map((tool) => {
    const requirement = REQUIREMENTS[tool.name] ?? { reads: [] };
    if (integration.admin) {
      return { tool: tool.name, write: tool.write, status: "ready", detail: "administrator" };
    }
    const blocked: string[] = [];
    for (const entity of requirement.reads) {
      const result = reads.get(entity);
      if (result && !result.ok) blocked.push(`${entity}:read missing (${result.detail})`);
    }
    for (const path of requirement.routes ?? []) {
      const result = routes.get(path);
      if (result && !result.ok) blocked.push(`${path.split("?")[0]} refused (${result.detail})`);
    }
    if (blocked.length > 0) {
      return { tool: tool.name, write: tool.write, status: "blocked", detail: blocked.join("; ") };
    }
    const reduced = (requirement.optionalRoutes ?? [])
      .map((path) => ({ path, result: routes.get(path) }))
      .filter(({ result }) => result && !result.ok)
      .map(({ path }) => `${path.split("?")[0]} refused`);
    const partial = reduced.length > 0 ? `reduced coverage: ${reduced.join(", ")}` : null;
    if (!tool.write) return { tool: tool.name, write: false, status: "ready", detail: partial };
    if (integration.privileges === null) {
      return {
        tool: tool.name,
        write: true,
        status: "unknown",
        detail: "reads work; the write privilege cannot be verified without writing",
      };
    }
    const missing = (requirement.writes ?? []).filter(
      (privilege) => !integration.privileges?.includes(privilege),
    );
    return missing.length > 0
      ? {
          tool: tool.name,
          write: true,
          status: "blocked",
          detail: `role lacks ${missing.join(", ")}`,
        }
      : {
          tool: tool.name,
          write: true,
          status: "ready",
          detail: "role grants the write privilege",
        };
  });

  const ok = readiness.every((item) => item.write || item.status === "ready");
  return { shop, connection: { ok: true, detail: null }, integration, tools: readiness, ok };
}

const MARK: Record<Readiness, string> = { ready: "✓", blocked: "✗", unknown: "?" };

/** Human-readable report for the terminal. */
export function formatDoctorReport(report: DoctorReport, url: string): string {
  const lines: string[] = [];
  if (!report.connection.ok) {
    lines.push(`Shop         ${url}`);
    lines.push(`Connection   failed: ${report.connection.detail ?? "unknown error"}`);
    lines.push("");
    lines.push(
      "Check SHOPWARE_URL, SHOPWARE_CLIENT_ID and SHOPWARE_CLIENT_SECRET, then run again.",
    );
    return `${lines.join("\n")}\n`;
  }
  const shop = report.shop;
  lines.push(
    `Shop         ${shop?.url ?? url} (Shopware ${shop?.version ?? "?"} ${shop?.edition ?? ""})`.trimEnd(),
  );
  const rights = report.integration.admin
    ? "administrator"
    : report.integration.privileges
      ? `${report.integration.privileges.length} privileges`
      : "role not readable, reads probed";
  const who = report.integration.label ? `${report.integration.label}, ` : "";
  lines.push(`Integration  ${who}${rights}`);
  lines.push("");
  lines.push("Tools");
  const width = Math.max(...report.tools.map((item) => item.tool.length));
  for (const item of report.tools) {
    const label = item.tool.padEnd(width);
    const show = item.detail && (item.status !== "ready" || item.detail.startsWith("reduced"));
    const suffix = show ? `  ${item.detail}` : "";
    lines.push(
      `  ${MARK[item.status]} ${label}${item.write ? "  (write)" : ""}${suffix}`.trimEnd(),
    );
  }
  lines.push("");
  const reads = report.tools.filter((item) => !item.write);
  const ready = reads.filter((item) => item.status === "ready").length;
  const writes = report.tools.filter((item) => item.write);
  const writeSummary =
    writes.length === 0
      ? "write tools not registered (start with --allow-write to check them)"
      : `${writes.filter((item) => item.status === "ready").length} of ${writes.length} write tools ready`;
  lines.push(`Result       ${ready} of ${reads.length} read tools ready, ${writeSummary}`);
  if (!report.ok) {
    lines.push(
      "Grant the missing privileges to the integration's role in Settings → System → Users & permissions, or use Administrator for a dev shop.",
    );
  }
  return `${lines.join("\n")}\n`;
}
