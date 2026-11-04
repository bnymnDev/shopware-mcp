import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { APP_MIME_TYPE, DASHBOARD_URI, EXTENSION_ID, VIEW_META_KEY } from "../src/apps.js";
import { createServer } from "../src/server.js";
import { createContext, fixture, mock, SHOP_URL, searchHandler } from "./helpers/shopware.js";

const clients: Client[] = [];

async function connect(ui: boolean): Promise<Client> {
  const server = createServer(createContext());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "host", version: "0.0.0" },
    {
      capabilities: ui
        ? ({ extensions: { [EXTENSION_ID]: { mimeTypes: [APP_MIME_TYPE] } } } as never)
        : {},
    },
  );
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** The pulse's order searches, answered from a real shop. */
function pulseSearches() {
  return http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
    const body = (await request.clone().json()) as { sort?: unknown };
    return HttpResponse.json(
      (body.sort ? fixture("pulse-last-order") : fixture("pulse-aggregations")) as JsonBodyType,
    );
  });
}

/** Every order search of the brief, answered like a real shop. */
function briefSearches() {
  return http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
    const body = (await request.clone().json()) as {
      sort?: { order?: string }[];
      limit?: number;
      aggregations?: { name?: string }[];
    };
    const name =
      body.sort?.[0]?.order === "DESC" && body.limit === 1
        ? "pulse-last-order"
        : body.aggregations?.some((agg) => agg.name === "o0")
          ? "pulse-aggregations"
          : body.aggregations
            ? "order-aggregations"
            : "orders-search";
    return HttpResponse.json(fixture<JsonBodyType>(name));
  });
}

describe("MCP Apps", () => {
  it("links the pulse, the audit, the sales report and the brief to one dashboard page", async () => {
    const client = await connect(true);
    const { tools } = await client.listTools();
    const linked = tools
      .filter((tool) => (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri)
      .map((tool) => tool.name)
      .sort();
    expect(linked).toEqual(["sales_report", "shop_audit", "shop_brief", "shop_pulse"]);
    expect(tools.find((tool) => tool.name === "shop_pulse")?._meta).toMatchObject({
      ui: { resourceUri: DASHBOARD_URI },
      "ui/resourceUri": DASHBOARD_URI,
    });

    const page = await client.readResource({ uri: DASHBOARD_URI });
    const content = page.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toMatch(/^<!doctype html>/);
    expect(content.text).toContain('"ui/initialize"');
    expect(content.text).toContain('"ui/notifications/tool-result"');
    // The page loads nothing from anywhere.
    expect(content.text).not.toMatch(/<(script|link|img)[^>]+(src|href)=/);
  });

  it("sends the rendered view to a host that shows apps, never to the model", async () => {
    mock.use(pulseSearches());
    const client = await connect(true);
    const result = await client.callTool({
      name: "shop_pulse",
      arguments: { timeZone: "Europe/Berlin" },
    });
    const html = (result._meta as Record<string, unknown> | undefined)?.[VIEW_META_KEY];
    expect(String(html)).toContain('class="banner');
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).not.toContain("<section");
  });

  it("gives the model a short brief and the page the whole one", async () => {
    mock.use(searchHandler({}));
    mock.use(briefSearches());
    const client = await connect(true);
    const result = await client.callTool({
      name: "shop_brief",
      arguments: { timeZone: "Europe/Berlin" },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(Object.keys(structured).sort()).toEqual([
      "audit",
      "headline",
      "last7Days",
      "shop",
      "today",
    ]);
    const html = String((result._meta as Record<string, unknown>)[VIEW_META_KEY]);
    expect(html).toContain("Right now");
    expect(html).toContain("Last 7 days");
  });

  it("leaves the view out for a host without apps", async () => {
    mock.use(pulseSearches());
    const client = await connect(false);
    const result = await client.callTool({
      name: "shop_pulse",
      arguments: { timeZone: "Europe/Berlin" },
    });
    expect(result._meta?.[VIEW_META_KEY]).toBeUndefined();
  });
});
