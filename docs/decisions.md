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

## The recordings are rendered, not recorded

The animated terminals in the README are SVGs generated by `scripts/render-demos.ts` from transcripts in `docs/demo/*.json`. Every tool call and result in a transcript was captured from the server against a real Shopware 6.7 shop and then shortened to fit a screen; the prose lines are what a host would say with them. Rendering from a transcript keeps the recordings reviewable in a diff, reproducible without a screen recorder, a few kilobytes each, and crisp at any size. They animate with SMIL, which plays inside a plain `<img>` on GitHub and npm without scripts, fonts or external assets.

## Two READMEs, one source of truth

Shopware is used most in German-speaking countries, so `README.de.md` carries a condensed German version of the front page: the pitch, the recordings, installation, the tool table and safety. The English `README.md` stays the complete one and every other document is English only, which keeps the translation small enough to maintain. The tool table is generated into both files from the same code, so they cannot drift apart there.

## Delivery and payment tools act on the newest record

Shopware keeps every delivery and transaction of an order and appends a new one on retries rather than replacing the old one, so "the" delivery of an order is the newest. `order_delivery_transition` and `order_transaction_transition` therefore resolve the newest record by `createdAt` unless an explicit id is given, and an explicit id must belong to the order or the call fails with `NOT_FOUND`. Tracking codes are written before the ship transition in the same call, and the dry run lists both requests, because "shipped with tracking code X" is one intent for the person asking.

## One static token, not an auth framework

The HTTP transport accepts a single bearer token from `SHOPWARE_MCP_HTTP_TOKEN`, compared in constant time. That covers the common case, a container on a private network with one or two hosts talking to it, without inventing users, roles or sessions that a reverse proxy already does better. `/healthz` stays open so load balancers can probe. Without a token the server still binds to loopback by default and warns when it listens further out.

## Requests time out

Every Admin API request carries an abort signal of `SHOPWARE_MCP_TIMEOUT_MS` (30 seconds by default). A shop that stops answering mid-request used to hang the tool call, and with it the host's turn, indefinitely. Now it fails one call with `TIMEOUT` and a hint, and the agent can say so.

## A date without a time covers the whole day

`sales_report { to: "2026-08-31" }` used to end at midnight and drop the last day's orders. A `to` given as a bare date now means the end of that day; a `from` given as a bare date already meant its start. Timestamps are taken as they are.

## Healthchecks use the public route

`/api/_info/version` needs a token in current Shopware versions and answers 401 to a bare probe, which left the nightly container "unhealthy" forever. Probes use `/api/_info/health-check`, which is public by design.

## Writes are retried only when a repeat cannot hurt

The client retries once on 429 and 5xx, but only for requests that are safe to repeat: reads, searches and PATCHes, which set absolute values. A `POST` to a state transition is excluded, because a proxy can answer 502 after Shopware has already applied `paid` or `ship`; a retry would then be rejected as an illegal transition and the tool would report a failure for a write that succeeded. `RequestOptions.idempotent` overrides the default for the rare exception.

## Documents travel as embedded resources

`document_download` returns the PDF as an MCP embedded resource next to a JSON summary, and the server strips the base64 payload from the text the model reads. The host gets the file, the model gets the metadata, and a 200 KB invoice does not cost 270 KB of context. Files above 8 MB are refused rather than truncated, because a truncated PDF is worthless.

## The doctor probes reads and reads the role for writes

Shopware answers a search with 403 when a privilege is missing, so `doctor` learns what an integration may read by asking for one row of every entity the tools use. Write privileges cannot be probed without writing, so they come from the integration's ACL roles when `integration:read` allows it, and are reported as unknown otherwise. An administrator integration skips the probing. The verdict is Shopware's, not a table in this repository.

## The write budget counts attempts

`SHOPWARE_MCP_MAX_WRITES` counts every real write a process attempts, before it is sent, and never a dry run. Counting attempts rather than successes is the conservative choice for a cap that exists to bound damage; a failed request may still have changed something.

## Legal pages are checked per storefront

Basic information in Shopware is inherited per sales channel, so the audit asks the system-config route with `inherit=1` for every active storefront and reports the channels that miss imprint, terms, privacy, revocation or shipping information. Headless channels have no pages to link and are skipped.

## Create tools choose the id

`product_create` and `promotion_create` generate the entity id before sending the POST and read the record back by that id. Shopware answers a create with 204 and no body unless asked otherwise, and a client-chosen id makes the read-back independent of that; it also means a retried request cannot create a second record, only fail on the duplicate. These two tools are the only non-idempotent writes, and they are marked as such for hosts and never retried by the client.

## A new product gets the shop's own tax and a derived net price

Shopware has no product without a tax. `product_create` takes a tax id or a rate, and without either it reads `core.tax.defaultTaxRate`, the setting the admin uses for the same purpose, falling back to the highest configured rate. The choice is echoed in the dry run. The net price is derived from the gross price with that rate and stored `linked`, as the admin does, so the shop keeps the two consistent.

## Promotions are created inactive

A promotion that is live the moment it exists cannot be reviewed. `promotion_create` defaults to `active: false`, and turning it on is a second, separate call to `promotion_toggle`. Only one code per promotion is supported; individual codes, set groups and rules stay in the admin.

## Reports rank within a bounded list

`customer_report` asks Shopware for one terms bucket per ordering customer, capped at a thousand, and ranks them in the server. Shopware's terms aggregation cannot sort by a nested sum, and the alternative, a query per customer, would not scale. Beyond the cap the report says so and the count of distinct customers still comes from a count aggregation that is not capped.

## Nothing deletes

There is no delete tool, and there will not be one. Every write in this server changes a record that stays visible, and the dry run shows what changes. A deleted product, promotion or review leaves nothing to show. Deactivating is the supported way to make something disappear from the storefront.

## The forecast is arithmetic on Shopware's own numbers

`stock_forecast` divides the units sold in the window (one terms aggregation over order line items, cancelled orders excluded) by the days of the window, and divides the available stock by that rate. No seasonality, no smoothing, no model: the number a merchant can check by hand, and the reason a product without sales is never listed. The reorder quantity covers the horizon plus a restock period, backlog included, because a negative stock is an order already owed.

## Aggregations go through the same guard as fields

`entity_search` accepts Shopware aggregations, and a terms aggregation prints its bucket keys. A key that is a password hash is a leak, so every aggregated field path, nested ones included, is checked against the same sensitive-name pattern that scrubs entity payloads, and the result passes through the scrubber. Credential entities stay refused altogether.

## The CLI exits like a check

`shopware-mcp audit` exits with 1 when a critical finding exists, with `--fail-on warning` when any warning exists, and with `--fail-on none` never. That is what cron, CI and monitoring expect from a check, and the Markdown on stdout is what a human expects from a mail. JSON is a flag away for anything that parses.

## Codex config is edited without a TOML parser

`init --write` for Codex CLI replaces exactly the `[mcp_servers.shopware]` table (up to the next top-level header) or appends one, and leaves every other byte alone. A TOML round trip through a parser would normalise a user's whole file; a targeted edit cannot.

## The shop downloads the picture, not the server

`product_cover_set` hands Shopware a URL and lets the shop fetch it, exactly as the admin's "upload from URL" does, so the file passes Shopware's own validation and lands in the product media folder. Bytes are accepted too, for hosts that can hand over a file. SVG is not, because an SVG is a document with scripts, not a picture. The four requests are shown as one dry run and applied in order; a failure leaves the earlier steps in place and says so, because a half-attached picture is visible and undoable in the admin, while a silent rollback could delete something a person added meanwhile.

## Settings are an allowlist, not a blocklist

Shopware keeps every setting in one table: shop name and mail passwords side by side. `shop_settings` reads only named core domains that describe trading, and drops keys that end like a credential; `entity_search` keeps refusing `system_config` altogether. A blocklist would have to know every plugin's secret in advance; an allowlist only has to know what a shop manager asks about.

## Extension packs read what the plugin already exposes

The FroshTools pack calls the plugin's own read routes and maps their answers; it never clears a cache, purges a queue or runs a task, although the plugin can. A pack is tested against the installed plugin before it ships, and its tools exist only in shops where the plugin is active.

## Bulk writes spend the budget per record

`order_documents_bulk_create` sends one request for up to fifty orders, because that is how Shopware's document generator works and one round trip is cheaper for everyone. The write budget still counts every order: a cap of twenty real writes means twenty invoices, not twenty calls. The unit is the record, not the HTTP request, which is why `tag_assign` or `product_cover_set` count once however many requests they send. The bulk tool charges the budget itself, before it sends anything, so a capped process refuses the whole batch rather than half of it and a refused batch costs nothing. Shopware answers with the created ids but not their orders, and it skips an order without an error when the document already exists, so the tool reads the new documents back and attributes them by order id instead of by position; an order that got neither a document nor an error is reported as skipped. The dry run also returns the exact `apply` arguments, with the orders pinned by id, so the real run cannot drift to different orders when a paid order arrives in between.

## Tags are named, not addressed

`tag_assign` takes tag names, because that is what people say ('mark him as VIP'), matches them the way Shopware's database does, without regard to case, and creates a tag that does not exist yet inside the same `PATCH`, so a failed request leaves no orphan tag behind. It adds to and removes from the record's tags without ever replacing the list, since `PATCH` with a `tags` array in Shopware means 'attach these' and a removal is its own request. A tag is the smallest mark Shopware's rules, flows and admin filters all understand, which is why it is a core tool and not a plugin's.

## Scheduled tasks are read, not run

`scheduled_tasks_list` reads the `scheduled_task` table and calls a waiting task overdue when it is past its next run by more than a grace period. It never runs, resets or deactivates a task: that is the scheduler's job, and a task started from an API call would hide the fact that the scheduler is down. The audit uses the same reading with an hour of grace, because a stalled scheduler explains many other findings, from missing invoices to stale search results.

