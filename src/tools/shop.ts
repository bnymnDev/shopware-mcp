import { DEFAULT_CURRENCY_ID, DEFAULT_LANGUAGE_ID } from "../client/constants.js";
import { equals } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { ShopwareMcpError } from "../errors.js";
import { logger } from "../logger.js";
import { bool, raw, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

export interface ShopInfo {
  url: string;
  version: string | null;
  versionRevision: string | null;
  edition: "Community" | "Commercial" | "Enterprise" | "unknown";
  defaultCurrency: {
    id: string;
    isoCode: string | null;
    symbol: string | null;
    name: string | null;
  };
  defaultLanguage: { id: string; name: string | null; locale: string | null };
  adminWorkerEnabled: boolean | null;
  warnings?: string[];
}

function detectEdition(bundles: string[]): ShopInfo["edition"] {
  if (bundles.some((name) => /^SwagEnterprise/i.test(name))) return "Enterprise";
  if (bundles.some((name) => /^SwagCommercial/i.test(name))) return "Commercial";
  return "Community";
}

function describeError(error: unknown): string {
  return error instanceof ShopwareMcpError ? `${error.code}: ${error.detail}` : String(error);
}

export async function fetchShopInfo(client: ShopwareClient): Promise<ShopInfo> {
  const [version, config, currency, language] = await Promise.allSettled([
    client.request<Raw>("/api/_info/version"),
    client.request<Raw>("/api/_info/config"),
    client.search<Raw>("currency", { filter: [equals("id", DEFAULT_CURRENCY_ID)], limit: 1 }),
    client.search<Raw>("language", {
      filter: [equals("id", DEFAULT_LANGUAGE_ID)],
      limit: 1,
      associations: { locale: {} },
    }),
  ]);

  if (version.status === "rejected") throw version.reason;
  const warnings: string[] = [];

  let edition: ShopInfo["edition"] = "unknown";
  let adminWorkerEnabled: boolean | null = null;
  if (config.status === "fulfilled") {
    const bundles = raw(config.value.bundles);
    edition = detectEdition(bundles ? Object.keys(bundles) : []);
    adminWorkerEnabled = bool(raw(config.value.adminWorker)?.enableAdminWorker);
  } else {
    warnings.push(`config unavailable (${describeError(config.reason)})`);
    logger.debug("shop_info: /_info/config failed");
  }

  const currencyEntity = currency.status === "fulfilled" ? (currency.value.items[0] ?? null) : null;
  if (currency.status === "rejected")
    warnings.push(`currency unavailable (${describeError(currency.reason)})`);
  const languageEntity = language.status === "fulfilled" ? (language.value.items[0] ?? null) : null;
  if (language.status === "rejected")
    warnings.push(`language unavailable (${describeError(language.reason)})`);

  const info: ShopInfo = {
    url: client.baseUrl,
    version: str(version.value.version),
    versionRevision: str(version.value.versionRevision),
    edition,
    defaultCurrency: {
      id: DEFAULT_CURRENCY_ID,
      isoCode: str(currencyEntity?.isoCode),
      symbol: str(currencyEntity?.symbol),
      name: translated(currencyEntity, "name"),
    },
    defaultLanguage: {
      id: DEFAULT_LANGUAGE_ID,
      name: str(languageEntity?.name),
      locale: str(raw(languageEntity?.locale)?.code),
    },
    adminWorkerEnabled,
  };
  if (warnings.length > 0) info.warnings = warnings;
  return info;
}

export const shopInfo = defineTool({
  name: "shop_info",
  title: "Shop info",
  description:
    "Get basic facts about the connected Shopware shop: version, edition (Community/Commercial), " +
    "default currency and default language. Use it first to orient yourself or to confirm the " +
    "connection works. Returns a single JSON object.",
  inputSchema: {},
  handler: (_input, ctx) => fetchShopInfo(ctx.client),
});
