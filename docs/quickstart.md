# Quickstart

Five minutes from zero to "which products are low on stock?".

## 1. Create an Integration in Shopware

1. Admin → **Settings → System → Integrations → Add integration**.
2. Name it (e.g. `mcp-agent`). For a dev shop tick *Administrator*; for production assign a role with **read** access to product, order, customer, category, promotion, plugin, sales channel, currency and language (plus **write** on product, order and promotion if you plan to use write tools).
3. Save and copy the **Access key ID** and **Secret access key**. The secret is shown once.

## 2. Run the server

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

- "Give me a low stock report below 5." → uses `products_search` (or the `low_stock_report` prompt).
- "Summarize order 10042 for a support reply." → `orders_get` (or the `order_summary` prompt).
- "Which customers ordered more than 10 times?" → `customers_search` with a `range` filter on `orderCount`.
- "Is the PayPal plugin up to date?" → `plugins_list`.

## 5. Enable writes (optional)

```bash
npx shopware-mcp --allow-write
```

Now `stock_set`, `product_update`, `order_state_transition` and `promotion_toggle` are registered. Each defaults to `dryRun: true`:

```
stock_set { productId: "…", stock: 3 }                  → { dryRun: true, wouldSend: { method: "PATCH", url: "…/api/product/…", body: { stock: 3 } } }
stock_set { productId: "…", stock: 3, dryRun: false }   → { dryRun: false, result: { productNumber: "SW10002", stock: 3, … } }
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

Need a raw field that is not in the compact output (e.g. `customFields`, `ean`, `weight`)? Pass `fields: ["customFields", "ean"]` and it is added to every item.
