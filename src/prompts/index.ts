import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "order_summary",
    {
      title: "Order summary for support",
      description: "Summarize one order so a support agent can reply to the customer.",
      argsSchema: {
        orderNumber: z.string().min(1).describe("Order number as shown to the customer"),
      },
    },
    ({ orderNumber }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Load order ${orderNumber} with the orders_get tool (orderNumber="${orderNumber}"). ` +
              "Then write a short, friendly summary for a customer-support reply: order date, " +
              "items with quantities, total with currency, payment state, delivery state, " +
              "tracking codes if any, and the shipping address. Mention anything that looks " +
              "stuck (e.g. paid but not shipped for a long time). Do not invent details that " +
              "are not in the order data.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "low_stock_report",
    {
      title: "Low stock report",
      description: "List active products whose stock is below a threshold.",
      argsSchema: {
        threshold: z.string().min(1).describe("Stock threshold, e.g. 5"),
      },
    },
    ({ threshold }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Use products_search with filter [{ "type": "range", "field": "stock", ` +
              `"value": { "lt": ${Number(threshold) || 5} } }, ` +
              `{ "type": "equals", "field": "active", "value": true }], ` +
              `sort [{ "field": "stock", "order": "ASC" }] and includeVariants=true. Page ` +
              "through the results if total exceeds one page (max 50 per page). Then produce " +
              "a table with product number, name, stock, available stock and manufacturer, " +
              "sorted by stock ascending, and end with the total count of affected products.",
          },
        },
      ],
    }),
  );
}
