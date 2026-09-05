import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApp } from "../src/transport/http.js";
import { createContext, mock } from "./helpers/shopware.js";

let baseUrl: string;
let guardedUrl: string;
const TOKEN = "correct-horse-battery-staple";
const app = createHttpApp(createContext(), { port: 0, host: "127.0.0.1" });
const guarded = createHttpApp(createContext(), { port: 0, host: "127.0.0.1", token: TOKEN });

beforeAll(async () => {
  // Real loopback traffic: msw cannot pass a streamed SSE response through its interceptor.
  mock.close();
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", () => resolve()));
  guardedUrl = `http://127.0.0.1:${(guarded.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => guarded.close(() => resolve()));
});

function rawPost(path: string, headers: Record<string, string>, body: string, base = baseUrl) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(base);
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

  it("requires the bearer token on /mcp when one is configured", async () => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const accept = "application/json, text/event-stream";
    const missing = await rawPost("/mcp", { accept }, ping, guardedUrl);
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    const wrong = await rawPost("/mcp", { accept, authorization: "Bearer nope" }, ping, guardedUrl);
    expect(wrong.status).toBe(401);
    const right = await rawPost(
      "/mcp",
      { accept, authorization: `Bearer ${TOKEN}` },
      ping,
      guardedUrl,
    );
    expect(right.status).toBe(200);
    // Health stays open so load balancers can probe without the secret.
    const health = await fetch(`${guardedUrl}/healthz`);
    expect(health.status).toBe(200);

    const client = new Client({ name: "http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${guardedUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
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
