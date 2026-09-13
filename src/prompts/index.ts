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
    "weekly_review",
    {
      title: "Weekly review",
      description:
        "A Monday-morning brief: health audit, last week's numbers against the week before, " +
        "and the next actions.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Run shop_audit with its defaults. Then run sales_report for the last 7 days " +
              '(from = today minus 7 days, to = today, interval "day", compareWithPrevious true). ' +
              "Write a brief of at most 250 words with three parts: 1) anything critical or " +
              "warning from the audit, with order numbers and product numbers; 2) last week " +
              "against the week before: orders, gross revenue, average order value, and the " +
              "top product; 3) the three most useful next actions, each with the exact tool " +
              "call you would make, dry run first for anything that writes. Use only figures " +
              "from the tool results.",
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

  server.registerPrompt(
    "customer_profile",
    {
      title: "Customer profile for support",
      description: "Who is this customer, what did they order, and what happened last?",
      argsSchema: {
        customer: z.string().min(1).describe("Customer number or e-mail address"),
      },
    },
    ({ customer }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Load the customer "${customer}" with customers_get (customerNumber or email, ` +
              "whichever it looks like). Then run orders_search with filter " +
              '[{ "type": "equals", "field": "orderCustomer.customerId", "value": "<id>" }] ' +
              "sorted by orderDateTime DESC, and order_history for the newest order. Write a " +
              "profile for a support colleague: account status and group, since when, order " +
              "count and lifetime revenue, the last three orders with state, payment and " +
              "delivery state, and what happened last on the newest order. Flag anything " +
              "that needs action (unpaid, unshipped, inactive account). Use only the tool " +
              "results.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "review_moderation",
    {
      title: "Review moderation queue",
      description: "Go through product reviews awaiting approval and propose a decision for each.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              'Run reviews_search with filter [{ "type": "equals", "field": "status", ' +
              '"value": false }] sorted by createdAt ASC. For each review, propose approve or ' +
              "hide with a one-line reason (spam, offensive, off-topic, or a genuine review), " +
              "and where a short public reply from the shop would help, draft it. Then list " +
              "the exact review_moderate calls, dry run first, and wait for confirmation " +
              "before applying any of them.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "reorder_list",
    {
      title: "Reorder list",
      description: "What to reorder this week, from real sales velocity and current stock.",
      argsSchema: {
        horizon: z.string().min(1).describe("Days ahead to cover, e.g. 14"),
      },
    },
    ({ horizon }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Run stock_forecast with days 30, horizon ${Number(horizon) || 14}, restockDays 30 ` +
              "and limit 50. Then write a purchase list: product number, name, current available " +
              "stock, units sold in the last 30 days, the day the stock runs out and the " +
              "suggested reorder quantity, soonest first. Group by manufacturer if products_get " +
              "on the first few items shows one. End with the total number of products affected " +
              "and the three most urgent ones. Use only figures from the tool results.",
          },
        },
      ],
    }),
  );
}
