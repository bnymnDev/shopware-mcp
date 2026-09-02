# shopware-mcp

## 0.1.0

### Minor Changes

- Initial release: MCP server for the Shopware 6 Admin API.
  - Read tools: `shop_info`, `sales_channels_list`, `products_search`, `products_get`, `orders_search`, `orders_get`, `customers_search`, `customers_get`, `categories_list`, `promotions_list`, `plugins_list`, `stock_get`.
  - Guarded write tools (`--allow-write`, `dryRun` default): `stock_set`, `product_update`, `order_state_transition`, `promotion_toggle`.
  - Resources `shopware://shop` and `shopware://sales-channels`, prompts `order_summary` and `low_stock_report`.
  - stdio and stateless Streamable HTTP transports, Docker image.
