---
"shopware-mcp": minor
---

Two new guarded write tools close the loop the audit opens: `order_delivery_transition` ships,
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

