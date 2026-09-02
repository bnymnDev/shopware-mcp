# Decisions

Answers to the open questions in SPEC.md and other choices made while building v0.1.

## `customFields` only on request

**Decision:** compact tool outputs never include `customFields`. Any search or get tool accepts `fields: string[]`; each entry (dot-paths allowed, e.g. `manufacturer.id`) is copied verbatim from the raw entity onto the item, so `fields: ["customFields"]` opts in.

**Why:** custom fields are shop-specific, often large, and rarely needed for a first answer. Opt-in keeps context windows small while still allowing everything.

## `products_search` excludes variants by default

**Decision:** `includeVariants` defaults to `false`, implemented as an extra `parentId equals null` filter. With `true`, variants are returned as regular items with `parentId` set.

**Why:** shops with configurator products would otherwise flood results with near-identical variant rows. Variant details are available through `products_get` (all children with options, stock and price) and `stock_get`.

## Inheritance header on product reads

All product searches send `sw-inheritance: true` so variants resolve inherited name, price, manufacturer and media from their parent. A variant's own `price` is `null` in `products_get.variants[]` when it inherits.

## JSON instead of JSON:API

Every request sends `Accept: application/json`. The Admin API then returns plain nested entities instead of JSON:API documents, which avoids client-side relationship resolution.

## Exact totals

Every search sets `total-count-mode: 1` so `total` is exact. It costs one count query per search; agents rely on `total` for pagination decisions, so the accuracy is worth it.

## Order state fields

`orders_search` returns `state` (order state machine), `paymentState` (state of the newest transaction) and `deliveryState` (first delivery). Shopware keeps every transaction; the newest one is the effective payment state.

## Category `productCount`

Shopware has no stored product count per category. `categories_list` runs one additional product search with a `terms` aggregation on `categories.id`, restricted to the categories on the current page. It counts direct assignments (not dynamic product streams or inherited assignments). If the aggregation fails (permissions), `productCount` is `null` and a `warnings` entry explains why.

## Customer default payment method

`defaultPaymentMethodId` exists in 6.6 and was removed in 6.7. Instead of an association (which would fail the whole request on 6.7), `customers_get` resolves it with a tolerant secondary lookup and additionally returns `lastPaymentMethod`.

## `plugins_list` merges two sources

`POST /api/search/plugin` lists plugins; `GET /api/_action/extension/installed` adds apps and the latest available version. If the second endpoint is not permitted, the tool returns plugins only plus a warning.

## `product_update` price merge

Product prices are one JSON array covering all currencies. To change a single currency without dropping the others, the tool reads the product first and merges. This read also happens in dry-run mode; dry run means "no writes", not "no requests".

## Write results

Dry runs return `{ dryRun: true, wouldSend: { method, url, body } }`. Real writes return `{ dryRun: false, result: <entity re-fetched with the matching read tool's shape> }`.

## `limit` above 50 is a validation error

Rather than silently clamping, the input schema declares `maximum: 50`, so an agent asking for 100 gets an explicit validation error and learns the cap.

## Stateless HTTP

`--http` creates a new `McpServer` and transport per request (no session IDs). Simpler to operate behind proxies and load balancers, and the server holds no per-client state anyway. Loopback binds enforce a `Host` header check against DNS rebinding.

## `--host` flag

Not in SPEC.md, but required to make the Docker image reachable (`--host 0.0.0.0`). Default stays `127.0.0.1`.
