import { z } from "zod";
import type { Raw, ShopwareClient } from "../client/index.js";
import { MAX_LIMIT } from "../config.js";
import { ShopwareMcpError } from "../errors.js";
import { logger } from "../logger.js";
import { bool, isRaw, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

const MAX_PAGES = 10;

export interface ExtensionInfo {
  name: string;
  label: string | null;
  version: string | null;
  type: "plugin" | "app";
  active: boolean;
  installed: boolean;
  installedAt: string | null;
  upgradeVersion: string | null;
  author: string | null;
  managedByComposer: boolean | null;
}

async function allPlugins(client: ShopwareClient): Promise<Raw[]> {
  const items: Raw[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await client.search<Raw>("plugin", {
      page,
      limit: MAX_LIMIT,
      sort: [{ field: "name", order: "ASC" }],
    });
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0) break;
  }
  return items;
}

function fromPlugin(plugin: Raw): ExtensionInfo {
  const installedAt = str(plugin.installedAt);
  return {
    name: str(plugin.name) ?? "",
    label: translated(plugin, "label"),
    version: str(plugin.version),
    type: "plugin",
    active: bool(plugin.active) ?? false,
    installed: installedAt !== null,
    installedAt,
    upgradeVersion: str(plugin.upgradeVersion),
    author: str(plugin.author),
    managedByComposer: bool(plugin.managedByComposer),
  };
}

function fromExtension(extension: Raw): ExtensionInfo {
  const installedAt = str(extension.installedAt);
  const version = str(extension.version);
  const latest = str(extension.latestVersion);
  return {
    name: str(extension.name) ?? "",
    label: str(extension.label),
    version,
    type: extension.type === "app" ? "app" : "plugin",
    active: bool(extension.active) ?? false,
    installed: installedAt !== null,
    installedAt,
    upgradeVersion: latest && latest !== version ? latest : null,
    author: str(extension.producerName),
    managedByComposer: null,
  };
}

export async function listExtensions(client: ShopwareClient) {
  const warnings: string[] = [];
  const [plugins, extensions] = await Promise.allSettled([
    allPlugins(client),
    client.request<unknown>("/api/_action/extension/installed"),
  ]);
  if (plugins.status === "rejected") throw plugins.reason;

  const byName = new Map<string, ExtensionInfo>();
  for (const plugin of plugins.value) {
    const info = fromPlugin(plugin);
    if (info.name) byName.set(info.name, info);
  }

  if (extensions.status === "fulfilled" && Array.isArray(extensions.value)) {
    for (const entry of extensions.value.filter(isRaw)) {
      const info = fromExtension(entry);
      if (!info.name) continue;
      const existing = byName.get(info.name);
      if (existing) {
        existing.upgradeVersion = existing.upgradeVersion ?? info.upgradeVersion;
        existing.label = existing.label ?? info.label;
      } else {
        byName.set(info.name, info);
      }
    }
  } else if (extensions.status === "rejected") {
    const reason = extensions.reason;
    const detail =
      reason instanceof ShopwareMcpError ? `${reason.code}: ${reason.detail}` : "failed";
    warnings.push(`apps and update info unavailable: /_action/extension/installed ${detail}`);
    logger.debug("extension endpoint failed");
  }

  const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { items, warnings };
}

export const pluginsList = defineTool({
  name: "plugins_list",
  title: "List plugins and apps",
  description:
    "List installed plugins and apps with version, active/installed state and the available " +
    "upgrade version (when the shop can reach the Shopware store). Use it to check whether an " +
    "extension is installed or outdated. Returns { total, items[] }.",
  inputSchema: {
    activeOnly: z.boolean().default(false).describe("Only return active extensions"),
    type: z.enum(["all", "plugin", "app"]).default("all").describe("Filter by extension type"),
  },
  handler: async (input, ctx) => {
    const { items, warnings } = await listExtensions(ctx.client);
    const filtered = items.filter(
      (item) =>
        (!input.activeOnly || item.active) && (input.type === "all" || item.type === input.type),
    );
    return warnings.length > 0
      ? { total: filtered.length, items: filtered, warnings }
      : { total: filtered.length, items: filtered };
  },
});
