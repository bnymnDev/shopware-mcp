# shopware-mcp

**The Shopware 6 MCP server.** Give Claude, Cursor or any MCP host a safe, complete view of your shop: products, orders, customers, stock, promotions, plugins, a one-shot **health audit**, aggregated **sales reports**, and schema-aware access to **every other Shopware entity**. Read-only by default. Writes only when you say so, and always with a dry run first.

<!-- TODO(demo): docs/demo.gif — Claude Desktop asking "Is everything okay with the shop?" -->

```
You:    Is everything okay with the shop?
Agent:  → shop_audit {}
        2 critical, 3 warnings.
        ● 3 paid orders not shipped for >7 days: #10042 (9 d), #10038, #10031
        ● Sales channel "Storefront" is in maintenance mode
        ▲ 12 active products out of stock, 7 below 5 units, 1 expired promotion still active
        Want me to reopen #10042 or deactivate the SUMMER promotion? (dry run first)
```

[![npm](https://img.shields.io/npm/v/shopware-mcp)](https://www.npmjs.com/package/shopware-mcp)
[![CI](https://github.com/bnymnDev/shopware-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bnymnDev/shopware-mcp/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-ff69b4)](https://github.com/sponsors/bnymnDev)

## Why this one

| | shopware-mcp |
|---|---|
| **Coverage** | 16 curated tools for the daily questions, plus `entity_search` + `entity_schema` for the other 200+ Shopware entities. Nothing is out of reach. |
| **Insight, not just CRUD** | `shop_audit` finds stuck orders, stock problems, expired promotions and pending updates in one call. `sales_report` aggregates revenue, states, channels, a timeline and top products server-side. |
| **Safe by default** | Write tools are not registered unless you pass `--allow-write`. Every write defaults to `dryRun: true`. Credentials never appear in output, logs or errors. Secrets are scrubbed from every entity payload. |
| **Built for agents** | Compact JSON with `total` for paging, LLM-written tool descriptions, Shopware Criteria filters 1:1 (no invented DSL), `fields` to opt into raw data like `customFields`. |
| **Runs anywhere** | `npx`, Docker, Claude Desktop extension (`.mcpb`), stdio and Streamable HTTP. Shopware 6.6+. |
| **Solid** | Token cache with early refresh, one retry on 401 and on 429/5xx, exact totals, 90+ unit tests against mocked Admin API responses, nightly e2e against dockware. |

## Install

Create an **Integration** in your Shopware admin (Settings → System → Integrations) and copy the access key ID and secret.

```bash
npx shopware-mcp                       # stdio (default)
npx shopware-mcp --http --port 3333    # Streamable HTTP on http://127.0.0.1:3333/mcp
npx shopware-mcp --allow-write         # also register the guarded write tools
```

### Claude Desktop

Download `shopware-mcp.mcpb` from the [latest release](https://github.com/bnymnDev/shopware-mcp/releases) and double-click it, or add this to `claude_desktop_config.json`:

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

### Claude Code

```bash
claude mcp add shopware \
  -e SHOPWARE_URL=https://shop.example.com \
  -e SHOPWARE_CLIENT_ID=SWIA... \
  -e SHOPWARE_CLIENT_SECRET=... \
  -- npx -y shopware-mcp
```

### Cursor / other MCP hosts

Any host that speaks stdio MCP works with the same `npx -y shopware-mcp` command and environment. For hosts that prefer HTTP, run `--http` and point them at `http://127.0.0.1:3333/mcp`.

### Docker

```bash
docker run --rm -p 3333:3333 \
  -e SHOPWARE_URL=https://shop.example.com \
  -e SHOPWARE_CLIENT_ID=SWIA... -e SHOPWARE_CLIENT_SECRET=... \
  ghcr.io/bnymndev/shopware-mcp
```

The image serves Streamable HTTP on port 3333. See [docs/self-hosting.md](docs/self-hosting.md) for stdio-in-Docker and reverse-proxy notes.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `SHOPWARE_URL` | yes | Shop base URL, e.g. `https://shop.example.com` (trailing slash is stripped) |
| `SHOPWARE_CLIENT_ID` | yes | Integration access key ID |
| `SHOPWARE_CLIENT_SECRET` | yes | Integration secret access key |
| `SHOPWARE_MCP_ALLOW_WRITE` | no | `true` registers the write tools. Default: off |
| `SHOPWARE_MCP_DEFAULT_LIMIT` | no | Default page size for search tools (default 20, max 50) |
| `SHOPWARE_LANGUAGE_ID` | no | Language UUID for translated fields (`sw-language-id`). Default: shop default language |
| `SHOPWARE_MCP_LOG_LEVEL` | no | `error` (default), `warn`, `info`, `debug`. Logs go to stderr only |

CLI flags override the environment: `--allow-write`, `--http`, `--port <n>`, `--host <addr>`, `--log-level <level>`.

The Integration needs read permissions on the entities you query and write permissions on product, order and promotion for the write tools. The *Administrator* role is the quick path for a dev shop; use a dedicated role in production (see [docs/self-hosting.md](docs/self-hosting.md#shopware-permissions)).

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

Full parameter reference: [docs/tools.md](docs/tools.md). Every search tool takes `{ term?, filter?, sort?, page?, limit?, fields? }` and returns `{ total, page, limit, items }`. Filters map 1:1 to Shopware Criteria filters, so anything you can filter in the Admin API works here too. See the [filter cheat sheet](docs/quickstart.md#filters-cheat-sheet).

Resources: `shopware://shop`, `shopware://sales-channels`. Prompts: `order_summary`, `low_stock_report`.

## Safety

- Without `--allow-write` (or `SHOPWARE_MCP_ALLOW_WRITE=true`) the server exposes read tools only. Agents cannot discover or call write tools.
- Write tools (`stock_set`, `product_update`, `order_state_transition`, `promotion_toggle`) default to `dryRun: true` and return `{ dryRun: true, wouldSend: { method, url, body } }` without touching the shop. Real writes return the re-fetched entity.
- `product_update` only touches name, description, active and one currency's price. Nothing else is writable.
- `entity_search` strips passwords, keys, tokens and hashes from every payload and refuses entities that exist to hold credentials or system internals (users, integrations, ACL roles, apps, system config).
- The HTTP transport has no authentication layer in v0.1. Bind it to localhost (the default) or put it behind a reverse proxy that authenticates.
- Secrets are never logged and never appear in error messages. Errors come back as `{ error: { status, code, detail } }`.

## Open core

Everything in this repository is MIT and stays that way. It covers one shop, one operator, interactive use.

Agencies and merchants running this at scale usually need more, and that is what I build and operate for clients:

- **Multi-shop**: one MCP endpoint that routes to dozens of shops with per-shop credentials and permissions
- **Hosted with audit trail**: every tool call logged with who/what/when, role-based access, SLA
- **Bulk operations and migrations**: mass price/stock updates, catalogue imports, safe rollbacks
- **Custom agents and Shopware plugins**: workflows tailored to your ERP, PIM or support desk

Interested? Open an issue with the `consulting` label or reach out via [github.com/bnymnDev](https://github.com/bnymnDev). Using shopware-mcp in production and want it to stay maintained? [Sponsoring](https://github.com/sponsors/bnymnDev) helps.

## Development

```bash
pnpm install
pnpm dev          # stdio server via tsx
pnpm test         # vitest + msw-mocked Admin API
pnpm build        # tsup → dist/ (npm) and dist/bundle/ (self-contained)
pnpm pack:mcpb    # Claude Desktop extension → shopware-mcp.mcpb
pnpm inspect      # MCP Inspector against dist/
pnpm docs:tools   # regenerate docs/tools.md + the table above
```

End-to-end tests against a real Shopware (`dockware/dev`) run with `pnpm test:e2e`; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
