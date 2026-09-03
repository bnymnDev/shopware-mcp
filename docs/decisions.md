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

## `shop_audit` is opinionated on purpose

Eight fixed checks with fixed severities rather than a configurable rules engine. Thresholds (`stuckOrderDays`, `lowStockThreshold`) are inputs; everything else is a judgement call that a shop owner would agree with. Each check runs independently; a permission error skips that check and is reported in `warnings` instead of failing the audit.

## `sales_report` uses server-side aggregations

Revenue, states, channels, currencies, the timeline and top products come from Criteria aggregations on `order` and `order_line_item`, so a year of orders costs three requests, not thousands. Amounts are summed in each order's currency; `revenueByCurrency` shows the split. Cancelled orders are excluded by default.

## `entity_search` is an escape hatch with guard rails

A generic tool makes the server complete without a tool per entity. The price is that raw entities may contain credentials, so every payload is scrubbed recursively (keys matching password, secret, token, access key, API key, private key, hash, salt) and entities that exist to hold credentials or system internals are blocked outright. `entity_schema` exposes the shop's own entity schema so agents can discover fields instead of guessing.

## User agent and language header

Every request carries `User-Agent: shopware-mcp/<version> (+repo url)` so operators can see the integration in their access logs, and `sw-language-id` when `SHOPWARE_LANGUAGE_ID` is set.

## Transient retry

429, 502, 503 and 504 are retried once after `Retry-After` (capped at 5 s) or 500 ms. Anything else surfaces immediately; agents should not wait on a broken shop.

## Two build outputs

`dist/index.js` keeps dependencies external for npm. `dist/bundle/index.js` inlines everything for the Claude Desktop extension (`.mcpb`), which has no package manager at install time.

## Two build outputs, one release pipeline

`dist/index.js` keeps dependencies external for npm; `dist/bundle/index.js` inlines everything for the Claude Desktop extension, which has no package manager at install time. One push to `main` publishes npm, the GitHub release with the `.mcpb` attached, the container image and the MCP registry entry.

## The MCP registry entry is published from CI

`mcp-publisher login github-oidc` authenticates the workflow as the repository owner, so the `io.github.bnymnDev` namespace is proven without a personal token and nobody needs the CLI on their machine. The registry verifies ownership by reading `mcpName` from the published npm package, which is why the job waits for npm to serve the new version first.

## Generated manifests are excluded from the formatter

`server.json` and `manifest.json` are written by `scripts/sync-server-json.ts`, which keeps their versions equal to `package.json`. The formatter would re-wrap them and fight the sync check, so they are excluded from Biome and owned by the script instead.

## Publishing is blocked while the repository is private

npm provenance requires a public repository, and a package whose repository link 404s looks abandoned. The release job therefore skips itself unless the repository is public, and `workflow_dispatch` exists so a release can be started deliberately.

## Plugin-aware tools are an extension point, not a vendor integration

The tool list is built from what the shop actually has. A pack under `src/extensions/` declares which plugins it needs, and its tools are registered only when all of them are installed and active. The lookup runs once per process, in the background, and a failure degrades to the core tool set instead of blocking startup. The protocol notifies connected clients about the changed tool list, so tools that appear a moment after connect are picked up without a reconnect.

Two rules keep this honest. No vendor is named in a core tool description or in any tool answer, because those texts are read by the model and an advertisement there would be an injection into someone else's agent. And every pack is additive, so a shop without the extension sees exactly the neutral server.

## Long values are truncated, not returned

Shopware stores files as base64 blobs on the entity, for example an archived invoice. A single one of those fills an agent's context and tells it nothing. `entity_search` and every explicitly requested raw field therefore cut strings at 2000 characters and say how long the original was.

## The audit reports duties, never products

`shop_audit` maps four duties that apply to shops selling into the EU: structured e-invoicing, an accessible storefront, packaging reporting and AI labelling. Coverage is guessed from the names and labels of active extensions, so the map says whether something plausible is installed, never whether the shop is compliant, and it recommends nothing. Shops outside the EU switch it off with `complianceChecks: false`.
