import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toErrorShape } from "../errors.js";
import { listSalesChannels } from "../tools/sales-channels.js";
import { fetchShopInfo } from "../tools/shop.js";
import type { ToolContext } from "../tools/types.js";

function jsonContents(uri: URL, value: unknown) {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) },
    ],
  };
}

export const RESOURCE_URIS = {
  shop: "shopware://shop",
  salesChannels: "shopware://sales-channels",
} as const;

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "shop",
    RESOURCE_URIS.shop,
    {
      title: "Shop info",
      description: "Shopware version, edition, default currency and language (same as shop_info).",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        return jsonContents(uri, await fetchShopInfo(ctx.client));
      } catch (error) {
        return jsonContents(uri, toErrorShape(error));
      }
    },
  );

  server.registerResource(
    "sales-channels",
    RESOURCE_URIS.salesChannels,
    {
      title: "Sales channels",
      description: "All sales channels with type, domains and active flag.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        return jsonContents(uri, await listSalesChannels(ctx.client, ctx.config.maxLimit));
      } catch (error) {
        return jsonContents(uri, toErrorShape(error));
      }
    },
  );
}
