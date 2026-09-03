import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorShape } from "./errors.js";
import { detectExtensionTools } from "./extensions/index.js";
import { logger } from "./logger.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { tools } from "./tools/index.js";
import type { ToolContext, ToolDefinition } from "./tools/types.js";
import { NAME, VERSION } from "./version.js";

export const SERVER_INSTRUCTIONS =
  "Tools for a Shopware 6 shop via its Admin API. Start with shop_info; use shop_audit for a " +
  "health overview and sales_report for figures. entity_search/entity_schema reach any other " +
  "entity. Read tools return compact JSON with " +
  "{ total, page, limit, items } for searches (limit max 50). Filters use Shopware Criteria " +
  "semantics: { type: equals|contains|range|equalsAny, field, value }. Write tools exist only " +
  "when the server was started with write access, and every write defaults to dryRun=true, " +
  "which returns the request that would be sent; re-run with dryRun=false to apply. Errors " +
  "come back as { error: { status, code, detail } }. Some shops expose extra tools for their " +
  "installed extensions; call tools/list again if a tool you were told about is missing.";

function toolResult(value: unknown, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  if (isError) result.isError = true;
  return result;
}

/** Tool names already registered per server, so a late detection cannot register a name twice. */
const registered = new WeakMap<McpServer, Set<string>>();

function registerTool(server: McpServer, tool: ToolDefinition, ctx: ToolContext): boolean {
  const names = registered.get(server) ?? new Set<string>();
  registered.set(server, names);
  if (names.has(tool.name)) return false;
  names.add(tool.name);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    },
    async (args) => {
      try {
        // The SDK has already validated `args` against `tool.inputSchema`.
        const value = await tool.handler(args as Parameters<typeof tool.handler>[0], ctx);
        return toolResult(value);
      } catch (error) {
        const shape = toErrorShape(error);
        logger.warn(`tool ${tool.name} failed`, { ...shape.error });
        return toolResult(shape, true);
      }
    },
  );
  return true;
}

const pendingExtensions = new WeakMap<McpServer, Promise<string[]>>();

/**
 * Resolves once plugin-aware tool detection has finished for this server.
 * Detection runs in the background so a slow or unreachable shop never delays startup.
 */
export function extensionsReady(server: McpServer): Promise<string[]> {
  return pendingExtensions.get(server) ?? Promise.resolve([]);
}

/**
 * Register the tools this shop qualifies for. The SDK notifies connected clients about the
 * changed tool list on its own, so tools that appear late are picked up without a reconnect.
 */
async function enableExtensionTools(server: McpServer, ctx: ToolContext): Promise<string[]> {
  const detected = await detectExtensionTools(ctx);
  const added: string[] = [];
  for (const entry of detected) {
    if (registerTool(server, entry.tool, ctx)) added.push(entry.tool.name);
  }
  return added;
}

/** Create a fully configured MCP server. Cheap enough to create per HTTP request. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  let count = 0;
  for (const tool of tools) {
    if (tool.write && !ctx.config.allowWrite) continue;
    registerTool(server, tool, ctx);
    count += 1;
  }
  registerResources(server, ctx);
  registerPrompts(server);
  logger.debug("server created", { tools: count, allowWrite: ctx.config.allowWrite });

  if (ctx.config.extensions) {
    pendingExtensions.set(
      server,
      enableExtensionTools(server, ctx).catch((error: unknown) => {
        logger.debug("plugin-aware tools unavailable", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return [];
      }),
    );
  }
  return server;
}
