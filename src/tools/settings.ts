import { z } from "zod";
import type { Raw } from "../client/index.js";
import { idSchema } from "./shared.js";
import { defineTool } from "./types.js";

/**
 * Shopware keeps every setting, plugin licences and mail passwords included, in one table.
 * Only these core domains are readable here; they describe how the shop trades, not how it
 * authenticates. Anything that smells like a credential is dropped from the values as well.
 */
export const SETTINGS_DOMAINS = {
  "core.basicInformation": "shop name, contact, legal pages, currency and language defaults",
  "core.loginRegistration": "guest checkout, double opt-in, password rules, required fields",
  "core.cart": "quantities, wishlist, subtotal and delivery time display, cart redirects",
  "core.listing": "products per page, default sorting, reviews, buy-in-listing, new badge",
  "core.tax": "default tax rate",
  "core.newsletter": "double opt-in for the newsletter",
  "core.address": "address form rules",
  "core.saveDocuments": "document storage",
} as const;

export type SettingsDomain = keyof typeof SETTINGS_DOMAINS;

/** Keys that end like a credential; `passwordMinLength` is a rule, `smtpPassword` is not. */
const SENSITIVE_SETTING = /(password|secret|token|apikey|licen[cs]e(key)?|credential|dsn)$/i;

export async function readSettings(
  client: { request<T>(path: string): Promise<T> },
  domains: SettingsDomain[],
  salesChannelId?: string,
) {
  const query = salesChannelId ? `&salesChannelId=${salesChannelId}&inherit=1` : "";
  const settings: Record<string, Record<string, unknown>> = {};
  for (const domain of domains) {
    const values = await client.request<Raw>(`/api/_action/system-config?domain=${domain}${query}`);
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const short = key.startsWith(`${domain}.`) ? key.slice(domain.length + 1) : key;
      if (SENSITIVE_SETTING.test(short)) continue;
      clean[short] = value;
    }
    settings[domain] = clean;
  }
  return { salesChannelId: salesChannelId ?? null, inherited: Boolean(salesChannelId), settings };
}

export const shopSettings = defineTool({
  name: "shop_settings",
  title: "Shop settings",
  description:
    "Read the shop's trading settings from Shopware's system configuration, for the whole shop " +
    "or one sales channel with inheritance: basic information (shop name, contact, legal " +
    "pages), login and registration (guest checkout, double opt-in, password rules), cart, " +
    "listing (products per page, sorting, reviews), tax, newsletter, addresses and documents. " +
    "Only these domains are readable; mail servers, licences and plugin secrets are not, and " +
    "credential-like keys are dropped. Use it for 'is guest checkout on?' or 'what is the " +
    "default tax?'. Returns { salesChannelId, inherited, settings: { <domain>: { key: value } } }.",
  inputSchema: {
    domains: z
      .array(z.enum(Object.keys(SETTINGS_DOMAINS) as [SettingsDomain, ...SettingsDomain[]]))
      .min(1)
      .max(8)
      .default(["core.basicInformation", "core.loginRegistration", "core.cart", "core.listing"])
      .describe(
        Object.entries(SETTINGS_DOMAINS)
          .map(([domain, what]) => `${domain}: ${what}`)
          .join("; "),
      ),
    salesChannelId: idSchema
      .optional()
      .describe("Sales channel UUID for its effective (inherited) values; omit for shop-wide"),
  },
  handler: (input, ctx) => readSettings(ctx.client, input.domains, input.salesChannelId),
});
