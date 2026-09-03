# shopware-mcp

## 0.2.1

### Patch Changes

- a35b7fd: Fix two mappings in the Merqo tools that only a real shop could reveal. The hub returns its plugin
  map keyed by plugin name rather than as a list, so `merqo_health` reported no plugins at all. Cart
  snapshots store `unitPrice` and `totalPrice` per line item, not a single `price`, so
  `merqo_abandoned_carts` dropped the amounts. Both shapes are now covered by fixtures taken from a
  live Shopware 6.7 and by an end-to-end test that fails if they drift again.
- 8d37ed1: Emit every union in a tool schema as `anyOf` branches with a single `type` each. Zod collapses a
  primitive-only union into `type: ["string", "number", …]`, which is legal JSON Schema but is read
  as a single string by several MCP clients, which then reject the tool or drop the constraint. The
  filter value, its list form and the range bounds were affected, so this touched every search tool.
  A test now walks the schema of every tool, core and plugin-aware, and fails on any array-valued
  `type`.
- 8caa12c: Fix `sales_report` returning zero revenue for most top products. Quantity and revenue were read
  from two independent top-N aggregations, and because Shopware breaks ties between equally frequent
  products arbitrarily, the two lists disagreed and the revenue lookup missed. Revenue is now
  resolved against the exact product ids from the first pass. The per-product count is also renamed
  to `lineItemCount`, which is what the aggregation actually counts.
  
  Verified against a Shopware 6.7 shop with sixty generated orders: totals, currency split, state
  buckets, the timeline and every top product now match the figures computed directly in SQL.

## 0.2.0

### Minor Changes

- 5cdb0d9: Plugin-aware tools: the server now detects which extensions a shop has installed and registers
  extra tools for the ones it knows, in the background and without delaying startup. A shop without
  the extension sees the unchanged core tool set, and `--no-extensions` turns detection off. The
  first supported suite is Merqo, adding compliance status, incoming e-invoices, returns and
  abandoned carts.
  
  `shop_audit` additionally reports which EU duties (structured e-invoicing, accessible storefront,
  packaging reporting, AI labelling) appear to be covered by an active extension. It names the duty
  and its deadline, never a product, and can be switched off with `complianceChecks: false`.
  
  `entity_search` and explicitly requested raw fields now truncate very long values, so a stored file
  such as an archived invoice can no longer fill an agent's context window.

## 0.1.1

### Patch Changes

- Correct the MCP registry namespace to match the GitHub owner exactly. The registry grants
  `io.github.bnymnDev/*` and compares it case-sensitively against the `mcpName` in the published
  package, so the lowercase spelling was rejected.

## 0.1.0

### Minor Changes

- Initial release: MCP server for the Shopware 6 Admin API.
  - Read tools: `shop_info`, `sales_channels_list`, `products_search`, `products_get`, `orders_search`, `orders_get`, `customers_search`, `customers_get`, `categories_list`, `promotions_list`, `plugins_list`, `stock_get`.
  - Guarded write tools (`--allow-write`, `dryRun` default): `stock_set`, `product_update`, `order_state_transition`, `promotion_toggle`.
  - Resources `shopware://shop` and `shopware://sales-channels`, prompts `order_summary` and `low_stock_report`.
  - Insight tools: `shop_audit` (prioritised health findings) and `sales_report` (server-side aggregations: revenue, states, channels, timeline, top products).
  - Generic access: `entity_search` for any Shopware entity with credential scrubbing and a blocked-entity list, `entity_schema` for field discovery.
  - stdio and stateless Streamable HTTP transports, Docker image, Claude Desktop extension manifest, MCP registry manifest.
  - Client: user agent, optional `SHOPWARE_LANGUAGE_ID`, one retry on 429/502/503/504.
