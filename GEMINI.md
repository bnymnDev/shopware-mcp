# shopware-mcp

Tools for one Shopware 6 shop through its Admin API.

- Start with `shop_brief` for the whole picture, or `shop_info` for the version and currency.
- "Is everything okay?": `shop_audit`. "Why are there no orders?": `shop_diagnose`.
- Figures: `sales_report`, `customer_report`, `returns_report`, `stock_forecast`.
- Before a campaign: `promotions_check`, `promotion_impact`, `margin_check`.
- Any other entity: `entity_schema`, then `entity_search` with Shopware Criteria filters.
- Writes exist only when the server runs with `--allow-write`, and each one is a dry run first.
