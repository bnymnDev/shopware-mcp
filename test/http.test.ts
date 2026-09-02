import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApp } from "../src/transport/http.js";
import { createContext, mock } from "./helpers/shopware.js";

let baseUrl: string;
const app = createHttpApp(createContext(), { port: 0, host: "127.0.0.1" });

beforeAll(async () => {
  // Real loopback traffic: msw cannot pass a streamed SSE response through its interceptor.
  mock.close();
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => app.close(() => resolve())));

function rawPost(path: string, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(baseUrl);
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("Streamable HTTP transport", () => {
  it("serves MCP on /mcp in stateless mode", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("products_search");
    // No Shopware behind this test: a validation failure proves the tool pipeline without network.
    const result = await client.callTool({ name: "stock_get", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });

  it("answers health checks and rejects other paths", async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(await health.json()).toEqual({ ok: true });
    const other = await fetch(`${baseUrl}/other`);
    expect(other.status).toBe(404);
  });

  it("blocks DNS-rebinding style Host headers on loopback", async () => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const accept = "application/json, text/event-stream";
    const blocked = await rawPost("/mcp", { host: "evil.example", accept }, ping);
    expect(blocked.status).toBe(403);
    const allowed = await rawPost("/mcp", { host: "localhost:1234", accept }, ping);
    expect(allowed.status).toBe(200);
  });
});
