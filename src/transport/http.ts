import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "../logger.js";
import { createServer } from "../server.js";
import type { ToolContext } from "../tools/types.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Path of the MCP endpoint. */
  path?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostHeaderAllowed(req: IncomingMessage, boundHost: string): boolean {
  if (!LOOPBACK_HOSTS.has(boundHost)) return true;
  const header = req.headers.host;
  if (!header) return true;
  const hostname = header.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(hostname);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Stateless Streamable HTTP transport: one McpServer + transport per request, no sessions.
 * No authentication layer; run it on localhost or behind a reverse proxy that adds one.
 */
export function createHttpApp(ctx: ToolContext, options: HttpOptions): Server {
  const mcpPath = options.path ?? "/mcp";

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== mcpPath) {
      json(res, 404, { error: { status: 404, code: "NOT_FOUND", detail: `Use ${mcpPath}` } });
      return;
    }
    if (!hostHeaderAllowed(req, options.host)) {
      json(res, 403, { error: { status: 403, code: "FORBIDDEN", detail: "Invalid Host header" } });
      return;
    }

    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("http request failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        json(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
}

export async function startHttp(ctx: ToolContext, options: HttpOptions): Promise<Server> {
  const app = createHttpApp(ctx, options);
  await new Promise<void>((resolve, reject) => {
    app.once("error", reject);
    app.listen(options.port, options.host, () => {
      app.off("error", reject);
      resolve();
    });
  });
  logger.info("listening", {
    url: `http://${options.host}:${options.port}${options.path ?? "/mcp"}`,
  });
  return app;
}
