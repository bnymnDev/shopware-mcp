import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorShape } from "./errors.js";
import { logger } from "./logger.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { tools } from "./tools/index.js";
import type { ToolContext, ToolDefinition } from "./tools/types.js";
import { NAME, VERSION } from "./version.js";

export const SERVER_INSTRUCTIONS =
  "Tools for a Shopware 6 shop via its Admin API. Read tools return compact JSON with " +
  "{ total, page, limit, items } for searches (limit max 50). Filters use Shopware Criteria " +
  "semantics: { type: equals|contains|range|equalsAny, field, value }. Write tools exist only " +
  "when the server was started with write access, and every write defaults to dryRun=true, " +
  "which returns the request that would be sent; re-run with dryRun=false to apply. Errors " +
  "come back as { error: { status, code, detail } }.";

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

function registerTool(server: McpServer, tool: ToolDefinition, ctx: ToolContext): void {
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
}

/** Create a fully configured MCP server. Cheap enough to create per HTTP request. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  let registered = 0;
  for (const tool of tools) {
    if (tool.write && !ctx.config.allowWrite) continue;
    registerTool(server, tool, ctx);
    registered += 1;
  }
  registerResources(server, ctx);
  registerPrompts(server);
  logger.debug("server created", { tools: registered, allowWrite: ctx.config.allowWrite });
  return server;
}
