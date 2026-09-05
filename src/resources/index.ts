import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { INHERITANCE_HEADERS, type Raw } from "../client/index.js";
import { toErrorShape } from "../errors.js";
import { fetchOrderDetail } from "../tools/orders.js";
import { fetchProductDetail } from "../tools/products.js";
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
  order: "shopware://order/{orderNumber}",
  product: "shopware://product/{productNumber}",
} as const;

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

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
        return jsonContents(
          uri,
          await fetchShopInfo(ctx.client, { writeEnabled: ctx.config.allowWrite }),
        );
      } catch (error) {
        return jsonContents(uri, toErrorShape(error));
      }
    },
  );

  server.registerResource(
    "order",
    new ResourceTemplate(RESOURCE_URIS.order, { list: undefined }),
    {
      title: "Order by number",
      description:
        "One order with line items, addresses, payment and delivery (same as orders_get).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const { mapped } = await fetchOrderDetail(ctx.client, {
          orderNumber: first(variables.orderNumber),
        });
        return jsonContents(uri, mapped);
      } catch (error) {
        return jsonContents(uri, toErrorShape(error));
      }
    },
  );

  server.registerResource(
    "product",
    new ResourceTemplate(RESOURCE_URIS.product, { list: undefined }),
    {
      title: "Product by number",
      description:
        "One product with prices, stock, categories and variants (same as products_get).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const product = await ctx.client.findOne<Raw>(
          "product",
          "productNumber",
          first(variables.productNumber),
          { includes: { product: ["id"] } },
          INHERITANCE_HEADERS,
        );
        return jsonContents(uri, await fetchProductDetail(ctx.client, String(product.id)));
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
