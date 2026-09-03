import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { extensionPacks } from "../src/extensions/index.js";
import { createServer } from "../src/server.js";
import { readTools, tools, writeTools } from "../src/tools/index.js";
import { createContext, mock, searchHandler } from "./helpers/shopware.js";

const clients: Client[] = [];

async function connect(allowWrite: boolean): Promise<Client> {
  const server = createServer(createContext({ allowWrite }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function textOf(result: unknown): unknown {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return JSON.parse(content[0]?.text ?? "null");
}

describe("MCP server", () => {
  it("registers only read tools by default", async () => {
    const client = await connect(false);
    const { tools: listed } = await client.listTools();
    const names = listed.map((tool) => tool.name).sort();
    expect(names).toEqual(readTools.map((tool) => tool.name).sort());
    expect(names).not.toContain("stock_set");
    expect(listed.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(listed.find((tool) => tool.name === "products_search")?.inputSchema).toMatchObject({
      type: "object",
      properties: { limit: { maximum: 50 } },
    });
  });

  it("registers write tools with --allow-write", async () => {
    const client = await connect(true);
    const { tools: listed } = await client.listTools();
    expect(listed).toHaveLength(tools.length);
    const stockSet = listed.find((tool) => tool.name === "stock_set");
    expect(stockSet?.annotations?.readOnlyHint).toBe(false);
    expect(stockSet?.inputSchema).toMatchObject({
      properties: { dryRun: { type: "boolean", default: true } },
    });
    expect(writeTools.map((tool) => tool.name)).toEqual([
      "stock_set",
      "product_update",
      "order_state_transition",
      "promotion_toggle",
    ]);
  });

  it("returns structured JSON from tools", async () => {
    const client = await connect(false);
    const result = await client.callTool({ name: "shop_info", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatchObject({ version: "6.6.10.3" });
    expect(result.structuredContent).toMatchObject({ version: "6.6.10.3" });
  });

  it("returns the compact error shape for Shopware errors", async () => {
    mock.use(searchHandler({ product: () => ({ total: 0, data: [] }) }));
    const client = await connect(false);
    const result = await client.callTool({
      name: "products_get",
      arguments: { productId: "00000000000000000000000000000000" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({
      error: { status: 404, code: "NOT_FOUND", detail: expect.stringContaining("product") },
    });
  });

  it("rejects invalid arguments before calling Shopware", async () => {
    const client = await connect(false);
    const result = await client.callTool({
      name: "products_search",
      arguments: { limit: 500 },
    });
    expect(result.isError).toBe(true);
  });

  it("exposes resources and prompts", async () => {
    const client = await connect(false);
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      "shopware://sales-channels",
      "shopware://shop",
    ]);
    const shop = await client.readResource({ uri: "shopware://shop" });
    expect(shop.contents[0]?.mimeType).toBe("application/json");
    const shopText = (shop.contents[0] as { text?: string } | undefined)?.text;
    expect(JSON.parse(String(shopText))).toMatchObject({ edition: "Community" });

    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      "low_stock_report",
      "order_summary",
    ]);
    const prompt = await client.getPrompt({
      name: "order_summary",
      arguments: { orderNumber: "10042" },
    });
    expect(prompt.messages[0]?.content).toMatchObject({ type: "text" });
    expect(JSON.stringify(prompt.messages[0]?.content)).toContain("10042");
  });
});

describe("tool schemas stay portable", () => {
  /**
   * `type: ["string", "number"]` is legal JSON Schema, but several MCP clients read `type` as a
   * single string and then reject the tool or drop the constraint. Every union must therefore
   * reach the wire as `anyOf` branches with one `type` each.
   */
  function arrayTypedPaths(node: unknown, path = "input"): string[] {
    if (Array.isArray(node)) {
      return node.flatMap((entry, index) => arrayTypedPaths(entry, `${path}[${index}]`));
    }
    if (typeof node !== "object" || node === null) return [];
    const found: string[] = [];
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "type" && Array.isArray(value))
        found.push(`${path}.type=${JSON.stringify(value)}`);
      else found.push(...arrayTypedPaths(value, `${path}.${key}`));
    }
    return found;
  }

  it("never emits an array-valued type, for any tool", () => {
    const every = [
      ...tools,
      ...extensionPacks.flatMap((pack) => pack.tools.map((entry) => entry.tool)),
    ];
    const offenders = every.flatMap((tool) =>
      arrayTypedPaths(z.toJSONSchema(z.object(tool.inputSchema), { io: "input" }), tool.name),
    );
    expect(offenders).toEqual([]);
    expect(every.length).toBeGreaterThan(15);
  });
});
