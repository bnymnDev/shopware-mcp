import type { Raw, ShopwareClient } from "../client/index.js";
import { MAX_LIMIT } from "../config.js";
import { logger } from "../logger.js";
import type { ToolContext, ToolDefinition } from "../tools/types.js";
import { merqoPack } from "./merqo.js";
import type { ExtensionPack, ExtensionTool } from "./types.js";

export type { ExtensionPack, ExtensionTool } from "./types.js";

/**
 * Plugin-aware tools. Every pack here is additive: its tools appear only in shops that have the
 * matching extensions installed and active. Adding a pack for another vendor's extensions is a
 * pull request away and changes nothing for anyone else.
 */
export const extensionPacks: ExtensionPack[] = [merqoPack];

const MAX_PLUGIN_PAGES = 10;

/** Active plugin names, cached per client for the lifetime of the process. */
const activePluginsCache = new WeakMap<ShopwareClient, Promise<Set<string>>>();

async function loadActivePlugins(client: ShopwareClient): Promise<Set<string>> {
  const names = new Set<string>();
  for (let page = 1; page <= MAX_PLUGIN_PAGES; page += 1) {
    const result = await client.search<Raw>("plugin", {
      page,
      limit: MAX_LIMIT,
      filter: [{ type: "equals", field: "active", value: true }],
      includes: { plugin: ["name", "active"] },
      sort: [{ field: "name", order: "ASC" }],
    });
    for (const plugin of result.items) {
      if (typeof plugin.name === "string") names.add(plugin.name);
    }
    if (names.size >= result.total || result.items.length === 0) break;
  }
  return names;
}

export function activePlugins(client: ShopwareClient): Promise<Set<string>> {
  let cached = activePluginsCache.get(client);
  if (!cached) {
    cached = loadActivePlugins(client).catch((error: unknown) => {
      activePluginsCache.delete(client);
      throw error;
    });
    activePluginsCache.set(client, cached);
  }
  return cached;
}

export interface DetectedTool {
  packId: string;
  tool: ToolDefinition;
}

const matches = (entry: ExtensionTool, installed: Set<string>): boolean =>
  entry.requires.every((plugin) => installed.has(plugin));

/**
 * Which plugin-aware tools this shop qualifies for. Never throws: a shop that cannot be reached
 * or an integration without plugin read access simply gets the core tool set.
 */
export async function detectExtensionTools(ctx: ToolContext): Promise<DetectedTool[]> {
  if (!ctx.config.extensions) return [];
  let installed: Set<string>;
  try {
    installed = await activePlugins(ctx.client);
  } catch (error) {
    logger.debug("extension detection skipped", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const detected: DetectedTool[] = [];
  for (const pack of extensionPacks) {
    for (const entry of pack.tools) {
      if (matches(entry, installed)) detected.push({ packId: pack.id, tool: entry.tool });
    }
  }
  if (detected.length > 0) {
    logger.info("plugin-aware tools enabled", {
      tools: detected.map((entry) => entry.tool.name).join(","),
    });
  }
  return detected;
}
