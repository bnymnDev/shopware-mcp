# Quickstart

Five minutes from zero to "which products are low on stock?".

## 1. Create an Integration in Shopware

1. Admin → **Settings → System → Integrations → Add integration**.
2. Name it (e.g. `mcp-agent`). For a dev shop tick *Administrator*; for production assign a role with **read** access to product, order, customer, category, promotion, plugin, sales channel, currency and language (plus **write** on product, order and promotion if you plan to use write tools).
3. Save and copy the **Access key ID** and **Secret access key**. The secret is shown once.

## 2. Run the server

The quickest path is the wizard, which tests the credentials and prints (or writes) the host configuration:

```bash
npx shopware-mcp init
npx shopware-mcp init --for cursor --write     # merge into ~/.cursor/mcp.json, backup kept
```

`npx shopware-mcp doctor` then tells you, per tool, whether the integration may use it and which privilege is missing; add `--allow-write` to include the write tools and `--json` for machines.

By hand:

```bash
export SHOPWARE_URL=https://shop.example.com
export SHOPWARE_CLIENT_ID=SWIA...
export SHOPWARE_CLIENT_SECRET=...

npx shopware-mcp
```

The server speaks MCP over stdio. Nothing is printed on stdout except protocol messages; diagnostics go to stderr (`--log-level debug` to see every request).

Try it interactively with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector npx -y shopware-mcp
```

## 3. Connect a host

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shopware": {
      "command": "npx",
      "args": ["-y", "shopware-mcp"],
      "env": {
        "SHOPWARE_URL": "https://shop.example.com",
        "SHOPWARE_CLIENT_ID": "SWIA...",
        "SHOPWARE_CLIENT_SECRET": "..."
      }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add shopware -e SHOPWARE_URL=https://shop.example.com -e SHOPWARE_CLIENT_ID=SWIA... -e SHOPWARE_CLIENT_SECRET=... -- npx -y shopware-mcp
```

**Cursor** — `.cursor/mcp.json` uses the same `command`/`args`/`env` shape as Claude Desktop.

## 4. Ask questions

- "Is everything okay with the shop?" → `shop_audit` returns prioritised findings with samples and hints.
- "How did we do in August?" → `sales_report` with `from`/`to`, grouped by day, week or month.
- "Which manufacturers have no logo?" → `entity_schema { entity: "product_manufacturer" }` then `entity_search` with a filter on `mediaId`.
- "Give me a low stock report below 5." → uses `products_search` (or the `low_stock_report` prompt).
- "Summarize order 10042 for a support reply." → `orders_get` (or the `order_summary` prompt).
- "Which customers ordered more than 10 times?" → `customers_search` with a `range` filter on `orderCount`.
- "Is the PayPal plugin up to date?" → `plugins_list`.
- "How was last week against the week before?" → `sales_report` with `compareWithPrevious: true`, or the `weekly_review` prompt.
- "Send me the invoice for 10042." → `order_documents_list`, then `document_download`; the PDF arrives as an embedded resource.
- "Note on 10042: customer called, ships Monday." → `order_note`.
- "What happened to order 10042?" → `order_history` lists every transition with who triggered it.
- "Who were our best customers this quarter?" → `customer_report` with `from`/`to` and `topCustomers`.
- "Which reviews are waiting for approval?" → `reviews_search` with a filter on `status`, or the `review_moderation` prompt; `review_moderate` approves or hides one.
- "Which payment methods does the storefront offer?" → `payment_methods_list` and `shipping_methods_list`.
- "Create a 10 % code AUTUMN10 for October." → `promotion_create`, inactive until you activate it.
- "What do I need to reorder?" → `stock_forecast` lists products whose stock runs out within the horizon, with a reorder quantity; the `reorder_list` prompt turns it into a purchase list.
- "Is guest checkout on?" → `shop_settings` with `domains: ["core.loginRegistration"]`, per sales channel with `salesChannelId`.
- "Give SW10084 a picture." → `product_cover_set` with `imageUrl`; the shop downloads the file into its product media folder, attaches it and sets it as the cover.
- "Orders per payment method, with revenue?" → `entity_search` on `order` with `aggregations: [{ name: "byPayment", type: "terms", field: "transactions.paymentMethod.name", aggregation: { name: "revenue", type: "sum", field: "amountTotal" } }]` and `limit: 1`.

## 5. Enable writes (optional)

```bash
npx shopware-mcp --allow-write
```

Now the fifteen write tools are registered: `stock_set`, `product_update`, `product_create`, `product_cover_set`, `order_state_transition`, `order_delivery_transition`, `order_transaction_transition`, `order_note`, `order_document_create`, `order_documents_bulk_create`, `promotion_toggle`, `promotion_create`, `customer_update`, `review_moderate` and `tag_assign`. Each defaults to `dryRun: true`, and `SHOPWARE_MCP_MAX_WRITES` (or `--max-writes`) caps the real writes of a process; a bulk call counts once per order:

```
stock_set { productId: "…", stock: 3 }                  → { dryRun: true, wouldSend: { method: "PATCH", url: "…/api/product/…", body: { stock: 3 } } }
stock_set { productId: "…", stock: 3, dryRun: false }   → { dryRun: false, result: { productNumber: "SW10002", stock: 3, … } }
order_delivery_transition { orderId: "…", transition: "ship", trackingCodes: ["00340434"] }
                                                          → { dryRun: true, wouldSend: [ PATCH …/api/order-delivery/…, POST …/state/ship ] }
order_transaction_transition { orderId: "…", transition: "paid", dryRun: false }
                                                          → { dryRun: false, result: { orderNumber: "10038", paymentState: "paid", … } }
stock_set { productId: "…", delta: 2 }                  → { dryRun: true, currentStock: 38, wouldSend: { …, body: { stock: 40 } } }
promotion_create { name: "Autumn 10", code: "AUTUMN10", discount: { type: "percentage", value: 10 }, salesChannelIds: ["…"] }
                                                          → { dryRun: true, wouldSend: { method: "POST", url: "…/api/promotion", body: { …, active: false } } }
```

## Filters cheat sheet

| Goal | Filter |
|---|---|
| Active products only | `{ "type": "equals", "field": "active", "value": true }` |
| Stock below 5 | `{ "type": "range", "field": "stock", "value": { "lt": 5 } }` |
| Orders since June | `{ "type": "range", "field": "orderDateTime", "value": { "gte": "2026-06-01" } }` |
| Orders in progress | `{ "type": "equals", "field": "stateMachineState.technicalName", "value": "in_progress" }` |
| Paid orders | `{ "type": "equals", "field": "transactions.stateMachineState.technicalName", "value": "paid" }` |
| Name contains "shirt" | `{ "type": "contains", "field": "name", "value": "shirt" }` |
| Several IDs | `{ "type": "equalsAny", "field": "id", "value": ["…", "…"] }` |
| By manufacturer | `{ "type": "equals", "field": "manufacturer.name", "value": "Acme" }` |

Reading a shop in another language? Set `SHOPWARE_LANGUAGE_ID` to the language UUID (find it with `entity_search { entity: "language" }`).

Need a raw field that is not in the compact output (e.g. `customFields`, `ean`, `weight`)? Pass `fields: ["customFields", "ean"]` and it is added to every item.

## Without an MCP host

The audit and the sales report also run from the command line, for cron jobs, CI or a quick look:

```bash
npx shopware-mcp audit                       # Markdown, exit 1 when a critical finding exists
npx shopware-mcp audit --fail-on warning     # exit 1 on warnings too; --days and --threshold tune the checks
npx shopware-mcp audit --json | jq .summary  # the same report as JSON
npx shopware-mcp report --from 2026-08-01 --to 2026-08-31 --interval week
```

A cron line that mails the audit every Monday morning and only bothers you when something is off:

```
0 7 * * 1  cd /srv/shop-tools && npx shopware-mcp audit --fail-on warning || mail -s "Shop audit" you@example.com < audit.md
```

