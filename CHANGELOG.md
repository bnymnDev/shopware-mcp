# shopware-mcp

## 0.3.1

### Patch Changes

- a5a7db3: The container image is now built for `linux/arm64` as well as `linux/amd64`, so it runs natively
  on Apple Silicon and ARM servers. The Claude Desktop bundle describes the current write tools,
  asks for an optional write budget alongside the credentials, and passes it as
  `SHOPWARE_MCP_MAX_WRITES`. A Smithery configuration lets that directory start the server with a
  user's shop credentials.

## 0.3.0

### Minor Changes

- 3004028: Documents: `order_documents_list` shows an order's invoices, delivery notes, credit notes and
  cancellations, `order_document_create` generates one with Shopware's own generator, and
  `document_download` hands the PDF to the host as an embedded resource while the model sees only
  the metadata. `order_note` writes an internal comment, appending a dated line by default.
  
  Two new commands: `shopware-mcp doctor` reports per tool whether the integration may use it,
  probing reads and reading the role for write privileges, and `shopware-mcp init` tests the
  credentials and prints or writes the configuration for Claude Desktop, Claude Code, Cursor,
  VS Code or Zed.
  
  `SHOPWARE_MCP_MAX_WRITES` caps the real writes a process may perform; dry runs stay free. The
  audit gains two checks, storefronts missing a legal page and products without a delivery time,
  and the server offers `shopware://order/{orderNumber}` and `shopware://product/{productNumber}`
  as resource templates. The nightly end-to-end run now covers Shopware 6.6 and 6.7.
- f8c27b1: Two new guarded write tools close the loop the audit opens: `order_delivery_transition` ships,
  returns, cancels or reopens an order's delivery and can set tracking codes in the same call, and
  `order_transaction_transition` marks the payment paid, reminded, refunded and so on. Both act on
  the order's newest delivery or transaction unless an id is given, and a dry run lists every
  request that would be sent.
  
  `sales_report` gains `compareWithPrevious`, which adds the preceding period of equal length and
  the change in orders, revenue and average order value. A `to` given as a bare date now covers the
  whole day; it used to end at midnight and drop the last day's orders. `shop_audit` adds a
  housekeeping check for orders that were paid and shipped but never completed, and a
  `weekly_review` prompt turns audit and report into a Monday-morning brief.
  
  The HTTP transport can require a bearer token (`SHOPWARE_MCP_HTTP_TOKEN`), compared in constant
  time, and warns when it listens beyond localhost without one. Every Admin API request now times
  out after `SHOPWARE_MCP_TIMEOUT_MS` (30 seconds by default) with a `TIMEOUT` error instead of
  hanging the session.
  
  The nightly end-to-end run against dockware failed since the first night: its container
  healthcheck probed `/api/_info/version`, which needs a token and answers 401. It now probes the
  public `/api/_info/health-check`.
  
  A review of the whole source fixed nine smaller bugs on the way. A transient 5xx no longer
  retries a state transition Shopware may already have applied (reads and PATCHes still retry
  once). A timeout while reading a response body is reported as `TIMEOUT`, not as an internal
  error. `product_update` keeps a currency's list and regulation prices when it changes the price,
  and reads variants with inheritance. A `range` filter with misspelt bounds is rejected instead of
  reaching Shopware as an empty range, and a time without an offset is read as UTC. `entity_search`
  expands nested association paths like `deliveries.shippingMethod` and strips `deepLinkCode`.
  Requested raw fields are truncated inside nested values too. Order summaries show the newest
  delivery, the one the transition tools act on. A `SHOPWARE_URL` ending in `/api` works. A stale
  401 no longer discards a token fetched in the meantime, and the HTTP transport warms the
  extension lookup at start so the first `tools/list` is complete.

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
