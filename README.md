<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/brand/banner-dark.svg">
    <img src="https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/brand/banner-light.svg" alt="shopware-mcp: the MCP server for Shopware 6" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/shopware-mcp"><img src="https://img.shields.io/npm/v/shopware-mcp?color=cb3837&logo=npm&logoColor=white" alt="npm"></a>
  <a href="https://github.com/bnymnDev/shopware-mcp/actions/workflows/ci.yml"><img src="https://github.com/bnymnDev/shopware-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/bnymnDev/shopware-mcp/actions/workflows/e2e.yml"><img src="https://github.com/bnymnDev/shopware-mcp/actions/workflows/e2e.yml/badge.svg" alt="nightly e2e against a real Shopware"></a>
  <a href="https://registry.modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP_registry-io.github.bnymnDev%2Fshopware--mcp-0b7bd6" alt="MCP registry"></a>
  <img src="https://img.shields.io/node/v/shopware-mcp?color=339933&logo=node.js&logoColor=white" alt="node">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

<p align="center">
  <a href="#introducing-shopware-mcp">Why</a> ·
  <a href="#see-it-work">Demo</a> ·
  <a href="#60-seconds">Install</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

---

## Introducing shopware-mcp

A Shopware 6 shop is about two hundred entities behind one Admin API. Ask an
assistant "is everything okay with the shop?" and the honest answer takes seven
searches with Criteria filters, three state machines by their technical names,
a couple of aggregations, and an OAuth token it must never repeat back to you.
Wire a model straight to that API and it gets all of it, including the right to
`PATCH` a price because a prompt said so.

The Model Context Protocol turned "give the model real tools" into a one-line
config change. It says nothing about what a good tool for a *shop* looks like:
which of the two hundred entities matter on a Tuesday morning, what "stuck
order" means, or that a stock correction should be shown before it is sent.

**shopware-mcp is that layer.** One small server that speaks MCP to the host
and the Admin API to the shop, and knows Shopware well enough to answer in one
call what used to take an afternoon in the admin:

| | |
|---|---|
| **Curated tools** | Products, orders, customers, categories, promotions, plugins, stock, sales channels: sixteen tools that return compact JSON with exact totals, descriptions written for a model, and Shopware's own Criteria filters. No invented query language. |
| **An audit** | `shop_audit` runs eight checks in one call: paid orders that never shipped, unpaid orders going stale, products out of stock or without a cover, promotions past their end date, channels in maintenance, extensions with updates waiting, and which EU duties look covered by an installed extension. Prioritised, with samples and a hint per finding. |
| **A report** | `sales_report` asks Shopware to aggregate: gross, net, average order, revenue per currency and channel, orders per state, a day/week/month timeline and the top products. The figures were checked against SQL on the same database. |
| **An escape hatch** | `entity_schema` describes any of the 200+ entities, a plugin's custom entities included, and `entity_search` queries them with the same filters. Entities that hold credentials are refused, secrets in the rest are scrubbed. |
| **A brake** | Read-only unless you start it with `--allow-write`. Even then every write is a dry run that shows the exact request first. Secrets never appear in output, logs or errors. |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/brand/architecture-dark.svg">
    <img src="https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/brand/architecture-light.svg" alt="An MCP host on the left, shopware-mcp in the middle, the Shopware 6 Admin API on the right. Tool calls flow right, compact JSON flows back." width="100%">
  </picture>
</p>

Shops are not identical, so the tool list is not either: at startup the server
looks up which extensions are installed and registers extra tools for the ones
it knows. A plain shop gets the core set. A shop with more plugins gets a bigger
agent, without configuration.

---

## See it work

Every recording on this page is real output from the server against a Shopware
6.7.13 test shop with generated demo data, replayed from the transcripts in
[`docs/demo/`](docs/demo). Tool calls and results are verbatim, shortened to
fit the screen. The prose is what an MCP host says with them.

**One question, eight checks.** Three paid orders are still waiting for shipment,
the storefront is in maintenance, a summer promotion outlived August. The
answer names order numbers and amounts, and offers the safe next step.

![shop_audit: the agent asks one question, the tool returns prioritised findings with samples, the agent summarises them](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/audit.svg)

**Numbers the shop computed itself.** Totals, channels, states, a monthly
timeline and the top product for eight months, from one call. No order was
paged through; Shopware's aggregations did the work.

![sales_report: totals, revenue by channel, orders by state, a monthly timeline and top products](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/report.svg)

**No tool for that? There is a schema for that.** Manufacturers have no
dedicated tool. The agent reads the entity's schema, spots `mediaId`, and
filters on it. The same path reaches every other entity, custom ones included.

![entity_schema then entity_search: the agent discovers the mediaId field and finds 27 manufacturers without a logo](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/anything.svg)

**Writes show their hand first.** With `--allow-write`, a stock correction
comes back as the request it *would* send. Only an explicit `dryRun: false`
touches the shop, and the result is re-read from Shopware.

![stock_set: a dry run returns the PATCH it would send, the agent asks, the real write follows and returns the re-read product](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/write.svg)

**A shop with more plugins gets a bigger agent.** The core tools are ready
immediately. The extension lookup finishes in the background, four tools appear,
the host is told to refresh its list, and a compliance question has an answer.

![Plugin-aware tools: tools/list grows from 16 to 20 after the extension lookup, then merqo_health answers a compliance question](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/demo/plugins.svg)

<details>
<summary><b>Screenshots from the MCP Inspector against the same shop</b></summary>
<br>

![shop_audit result in the MCP Inspector](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/screenshots/shop-audit.png)

![sales_report result in the MCP Inspector](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/screenshots/sales-report.png)

![The tool list with plugin-aware tools registered](https://raw.githubusercontent.com/bnymnDev/shopware-mcp/main/docs/screenshots/plugin-aware-tools.png)

</details>

---

## What's in the box

| | |
|---|---|
| **Sixteen curated tools** | `products_search`, `orders_get`, `customers_search`, `stock_get`, `promotions_list`, `plugins_list` and friends. Each takes `{ term?, filter?, sort?, page?, limit?, fields? }` and returns `{ total, page, limit, items }`. |
| **Health audit** | `shop_audit` with tunable thresholds (`stuckOrderDays`, `lowStockThreshold`, `maxItems`). Eight checks, prioritised findings, a hint per finding, and an EU duty overview that names duties and deadlines, never products. |
| **Sales report** | `sales_report` for any period, by day, week or month, optionally per sales channel, cancelled orders excluded. Top products resolved by exact product id so ties cannot skew revenue. |
| **Any entity** | `entity_schema` lists all entities or describes one: fields, types, flags, associations. `entity_search` queries it. Long text values are truncated, secrets scrubbed, credential entities refused. |
| **Plugin-aware tools** | The server detects installed, active extensions and adds tools for the ones it knows. First pack: [Merqo](https://github.com/bnymnDev/merqo). Off with `--no-extensions`. |
| **Guarded writes** | `stock_set`, `product_update`, `order_state_transition`, `promotion_toggle`. Registered only with `--allow-write`, `dryRun: true` by default, the re-fetched entity on a real write. |
| **Resources and prompts** | `shopware://shop`, `shopware://sales-channels`, and two ready-made prompts: `order_summary` for support replies and `low_stock_report`. |
| **Shopware's vocabulary** | Filters are Shopware Criteria filters (`equals`, `contains`, `range`, `equalsAny`) on Shopware field paths, including associations like `manufacturer.name`. State names are the technical names you already know. |
| **Portable schemas** | Every tool schema is checked to avoid constructs that some MCP clients misread, so the same server works in every host. |
| **A solid client** | OAuth client credentials with early token refresh, one retry on 401 and on 429/5xx with `Retry-After`, exact totals, inheritance and language headers, a cached entity schema. |
| **Two transports** | stdio for desktop hosts, stateless Streamable HTTP for everything else. |
| **Packaged four ways** | npm with build provenance, a Docker image on GHCR, a one-click `.mcpb` bundle for Claude Desktop, and a listing in the official MCP registry. |

---

## Who it is for

- **You run a shop** and want to ask it questions instead of clicking through the admin. Stuck orders, low stock, last month's numbers, one prompt each.
- **You run an agency** and look after many shops. The core here covers one shop per server; the multi-shop, audited, hosted version is what the author builds for clients (see [Open core](#open-core)).
- **You build Shopware plugins** and want your custom entities reachable by an agent today, and your own tools registered tomorrow. `entity_search` does the first; one file under `src/extensions/` does the second.
- **You build agents** and want an MCP server that behaves: compact output, honest totals, dry runs, no surprises in the schema.

---

## 60 seconds

**1.** Create an Integration in your Shopware admin: *Settings → System → Integrations → Add integration*. Copy the access key ID and the secret; the secret is shown once. For a dev shop tick *Administrator*, for production give it a read role (see [permissions](docs/self-hosting.md#shopware-permissions)).

**2.** Run the server:

```bash
export SHOPWARE_URL=https://shop.example.com
export SHOPWARE_CLIENT_ID=SWIA...
export SHOPWARE_CLIENT_SECRET=...

npx shopware-mcp                       # stdio (default)
npx shopware-mcp --http --port 3333    # Streamable HTTP on http://127.0.0.1:3333/mcp
npx shopware-mcp --allow-write         # also register the guarded write tools
```

**3.** Connect a host:

<details>
<summary><b>Claude Desktop</b></summary>
<br>

Download `shopware-mcp.mcpb` from the [latest release](https://github.com/bnymnDev/shopware-mcp/releases/latest) and double-click it, or add this to `claude_desktop_config.json`:

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

</details>

<details>
<summary><b>Claude Code</b></summary>
<br>

```bash
claude mcp add shopware \
  -e SHOPWARE_URL=https://shop.example.com \
  -e SHOPWARE_CLIENT_ID=SWIA... \
  -e SHOPWARE_CLIENT_SECRET=... \
  -- npx -y shopware-mcp
```

</details>

<details>
<summary><b>Cursor, VS Code, Zed, Windsurf and other stdio hosts</b></summary>
<br>

They all take the same three fields. Cursor reads `.cursor/mcp.json`, VS Code `.vscode/mcp.json` (under `servers` instead of `mcpServers`), Zed its `context_servers` block:

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

Hosts that read the [official MCP registry](https://registry.modelcontextprotocol.io) find it as `io.github.bnymnDev/shopware-mcp`.

</details>

<details>
<summary><b>Docker and HTTP hosts</b></summary>
<br>

```bash
docker run --rm -p 3333:3333 \
  -e SHOPWARE_URL=https://shop.example.com \
  -e SHOPWARE_CLIENT_ID=SWIA... -e SHOPWARE_CLIENT_SECRET=... \
  ghcr.io/bnymndev/shopware-mcp
```

The image serves Streamable HTTP on `http://127.0.0.1:3333/mcp`. Point any HTTP-capable host at that URL. The transport has no authentication of its own, so keep it on localhost or behind a proxy that authenticates ([self-hosting notes](docs/self-hosting.md)).

</details>

**4.** Ask. The first useful question is usually *"Is everything okay with the shop?"*

---

## Ask it anything

| You say | The agent calls |
|---|---|
| "Is everything okay with the shop?" | `shop_audit` |
| "How did we do in August?" | `sales_report { from, to, interval: "week" }` |
| "Which products are below 5 in stock?" | `products_search` with a `range` filter, or the `low_stock_report` prompt |
| "Summarise order 10042 for a support reply." | `orders_get`, or the `order_summary` prompt |
| "Which customers ordered more than ten times?" | `customers_search` with a `range` filter on `orderCount` |
| "Is the PayPal plugin up to date?" | `plugins_list` |
| "Which manufacturers have no logo?" | `entity_schema` then `entity_search` on `product_manufacturer` |
| "Set the stock of SW10084 to 40." | `stock_set`, dry run first, then for real |

---

## Filters, in one screen

Every search tool takes the same `filter` array, and every entry is a Shopware Criteria filter:

```json
{ "type": "equals",    "field": "active",                                    "value": true }
{ "type": "range",     "field": "stock",                                     "value": { "lt": 5 } }
{ "type": "range",     "field": "orderDateTime",                             "value": { "gte": "2026-06-01" } }
{ "type": "equals",    "field": "transactions.stateMachineState.technicalName", "value": "paid" }
{ "type": "contains",  "field": "name",                                      "value": "shirt" }
{ "type": "equalsAny", "field": "id",                                        "value": ["…", "…"] }
{ "type": "equals",    "field": "manufacturer.name",                         "value": "Acme" }
```

Anything you can filter in the Admin API works here too, associations included.
Need a raw field that the compact output leaves out, such as `customFields`,
`ean` or `weight`? Pass `fields: ["customFields", "ean"]` and it is added to
every item. Reading a shop in another language? Set `SHOPWARE_LANGUAGE_ID`.
The full [cheat sheet](docs/quickstart.md#filters-cheat-sheet) has more.

---

## Tools

<!-- TOOLS:START -->
| Tool | Access | Purpose |
|---|---|---|
| [`shop_info`](docs/tools.md#shop_info) | read | Shop info |
| [`sales_channels_list`](docs/tools.md#sales_channels_list) | read | List sales channels |
| [`products_search`](docs/tools.md#products_search) | read | Search products |
| [`products_get`](docs/tools.md#products_get) | read | Get product |
| [`orders_search`](docs/tools.md#orders_search) | read | Search orders |
| [`orders_get`](docs/tools.md#orders_get) | read | Get order |
| [`customers_search`](docs/tools.md#customers_search) | read | Search customers |
| [`customers_get`](docs/tools.md#customers_get) | read | Get customer |
| [`categories_list`](docs/tools.md#categories_list) | read | List categories |
| [`promotions_list`](docs/tools.md#promotions_list) | read | List promotions |
| [`plugins_list`](docs/tools.md#plugins_list) | read | List plugins and apps |
| [`stock_get`](docs/tools.md#stock_get) | read | Get stock |
| [`sales_report`](docs/tools.md#sales_report) | read | Sales report |
| [`shop_audit`](docs/tools.md#shop_audit) | read | Shop health audit |
| [`entity_schema`](docs/tools.md#entity_schema) | read | Entity schema |
| [`entity_search`](docs/tools.md#entity_search) | read | Search any entity |
| [`stock_set`](docs/tools.md#stock_set) | write (guarded) | Set stock (guarded) |
| [`product_update`](docs/tools.md#product_update) | write (guarded) | Update product (guarded) |
| [`order_state_transition`](docs/tools.md#order_state_transition) | write (guarded) | Transition order state (guarded) |
| [`promotion_toggle`](docs/tools.md#promotion_toggle) | write (guarded) | Toggle promotion (guarded) |
<!-- TOOLS:END -->

Every parameter of every tool: [docs/tools.md](docs/tools.md). Searches return
`{ total, page, limit, items }` with exact totals, `limit` is capped at 50, and
errors come back as `{ error: { status, code, detail } }` so the model can
react instead of guessing.

Resources: `shopware://shop`, `shopware://sales-channels`.
Prompts: `order_summary`, `low_stock_report`.

### Plugin-aware tools

At startup the server asks the shop which extensions are installed and active,
in the background, and registers extra tools for the ones it knows. A shop that
does not answer simply keeps the core tools. `--no-extensions` turns the whole
mechanism off.

Today one suite is supported, [Merqo](https://github.com/bnymnDev/merqo), which
adds `merqo_health`, `merqo_einvoice_inbox`, `merqo_returns_search` and
`merqo_abandoned_carts`. Shops without it never see those tools, and nothing in
the core tools changes either way. Support for another vendor's extensions is
one file under `src/extensions/`; pull requests are welcome.

---

## Safety

- **Read-only by default.** Without `--allow-write` (or `SHOPWARE_MCP_ALLOW_WRITE=true`) the write tools are not registered. An agent cannot discover what it cannot call.
- **Every write is a dry run first.** `stock_set`, `product_update`, `order_state_transition` and `promotion_toggle` default to `dryRun: true` and return `{ dryRun: true, wouldSend: { method, url, body } }`. A real write returns the re-fetched entity.
- **Narrow writes.** `product_update` touches name, description, active and one currency's price. Nothing else is writable.
- **Scrubbed reads.** `entity_search` strips passwords, keys, tokens and hashes from every payload and refuses entities that exist to hold credentials or system internals: users, integrations, ACL roles, apps, system config.
- **No secrets anywhere.** Credentials never appear in output, logs or error messages. Logs go to stderr only, at `error` level unless you ask for more.
- **No telemetry.** The server talks to your shop and to your host. Nothing else.
- **HTTP transport.** No authentication layer of its own. Bind it to localhost (the default) or put it behind a reverse proxy that authenticates.

Found something? See [SECURITY.md](SECURITY.md).

---

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `SHOPWARE_URL` | yes | Shop base URL, e.g. `https://shop.example.com` (trailing slash is stripped) |
| `SHOPWARE_CLIENT_ID` | yes | Integration access key ID |
| `SHOPWARE_CLIENT_SECRET` | yes | Integration secret access key |
| `SHOPWARE_MCP_ALLOW_WRITE` | no | `true` registers the write tools. Default: off |
| `SHOPWARE_MCP_DEFAULT_LIMIT` | no | Default page size for search tools (default 20, max 50) |
| `SHOPWARE_MCP_EXTENSIONS` | no | `false` disables plugin-aware tools and the extension lookup at startup |
| `SHOPWARE_LANGUAGE_ID` | no | Language UUID for translated fields (`sw-language-id`). Default: shop default language |
| `SHOPWARE_MCP_LOG_LEVEL` | no | `error` (default), `warn`, `info`, `debug`. Logs go to stderr only |

CLI flags override the environment: `--allow-write`, `--no-extensions`, `--http`, `--port <n>`, `--host <addr>`, `--log-level <level>`.

The Integration needs read permissions on the entities you query and write
permissions on product, order and promotion for the write tools. *Administrator*
is the quick path for a dev shop; use a dedicated role in production
([which permissions](docs/self-hosting.md#shopware-permissions)).

---

## Design principles

1. **Shopware's vocabulary, not ours.** Filters, field paths, state names and entity names are Shopware's. A tool call reads like the Admin API request it becomes, and a Shopware developer needs no second dictionary.
2. **Compact by default, complete on request.** Items carry what a model needs to reason and page. Raw fields come with `fields`, more rows with `page`, and long text is truncated rather than dumped.
3. **Reading is free, writing is explicit.** Write tools exist only when asked for, default to a dry run, and return the exact request. The model sees the consequence before the shop does.
4. **Let the shop do the maths.** Totals, timelines and top products are Shopware aggregations with exact counts, not client-side sums over pages.
5. **Vendor-neutral core.** Extension packs live in their own files, are registered only when the shop has the extension, and never change how the core tools behave. No telemetry, no phone-home.

The reasoning behind individual choices is in [docs/decisions.md](docs/decisions.md).

---

## Documentation

| Document | What is in it |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | Integration, first run, host configs, example questions, the filters cheat sheet |
| [docs/tools.md](docs/tools.md) | Every tool with every parameter, generated from the code |
| [docs/self-hosting.md](docs/self-hosting.md) | Transports, Docker, reverse proxies, Shopware permissions, operations |
| [docs/decisions.md](docs/decisions.md) | Design decisions and the reasoning behind each |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, ground rules, end-to-end tests, releasing |
| [SECURITY.md](SECURITY.md) | What to report and where |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |

---

## Open core

Everything in this repository is MIT and stays that way. It covers one shop, one operator, interactive use.

The same author builds [Merqo](https://github.com/bnymnDev/merqo), a commercial suite of Shopware
extensions for EU compliance and daily operations. This server detects them and adds matching
tools, but it never requires them, and the core tools behave the same either way.

Agencies and merchants running this at scale usually need more, and that is what I build and operate for clients:

- **Multi-shop**: one MCP endpoint that routes to dozens of shops with per-shop credentials and permissions
- **Hosted with audit trail**: every tool call logged with who, what and when, role-based access, SLA
- **Bulk operations and migrations**: mass price and stock updates, catalogue imports, safe rollbacks
- **Custom agents and Shopware plugins**: workflows tailored to your ERP, PIM or support desk

Interested? Open an issue with the `consulting` label or reach out via [github.com/bnymnDev](https://github.com/bnymnDev). Using shopware-mcp in production and want it to stay maintained? [Sponsoring](https://github.com/sponsors/bnymnDev) helps.

---

## Building from source

```bash
pnpm install
pnpm dev          # stdio server via tsx
pnpm test         # vitest + msw-mocked Admin API
pnpm build        # tsup → dist/ (npm) and dist/bundle/ (self-contained)
pnpm pack:mcpb    # Claude Desktop bundle → shopware-mcp.mcpb
pnpm inspect      # MCP Inspector against dist/
pnpm docs:tools   # regenerate docs/tools.md and the tool tables in both READMEs
pnpm docs:demos   # re-render the recordings in docs/demo/ from their transcripts
```

End-to-end tests against a real Shopware (`dockware/dev`, or any shop you point them at) run with `pnpm test:e2e`; see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Status

v0.2. Everything on this page is implemented, covered by unit tests against
mocked Admin API responses, and exercised nightly end-to-end against a real
Shopware. The recordings above come from Shopware 6.7.13; 6.6 is supported too.

Not in it, on purpose: authentication in front of the HTTP transport (use a
proxy), multi-shop routing and audit trails (the commercial part), and write
tools beyond the four that a support desk needs on a normal day.

Ideas that fit: more extension packs, better error hints for common Shopware
ACL problems, a `products_search` example gallery. The [good first
issues](https://github.com/bnymnDev/shopware-mcp/labels/good%20first%20issue)
are a fine place to start.

## License

[MIT](LICENSE)

<p align="center"><sub>If shopware-mcp answered a question your admin could not, a star helps the next shop find it.</sub></p>
