# shopware-mcp

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
