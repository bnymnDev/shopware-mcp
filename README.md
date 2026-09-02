# shopware-mcp

**Let AI agents work your Shopware 6 shop.** An MCP server for the Shopware 6 Admin API: Claude Code, Claude Desktop, Cursor or any MCP host can search products, orders, customers, stock and more, and, only when you explicitly allow it, apply guarded changes with a dry run first.

<!-- TODO(demo): docs/demo.gif — Claude Desktop asking "Which orders are stuck in progress?" -->

```
You:    Which orders are stuck in "in progress" for more than a week?
Agent:  → orders_search { filter: [{ type: "equals", field: "stateMachineState.technicalName", value: "in_progress" },
                                   { type: "range", field: "orderDateTime", value: { lt: "2026-08-26" } }] }
        Three orders: #10042 (paid, not shipped, 9 days), #10038 (…), #10031 (…)
```

[![npm](https://img.shields.io/npm/v/shopware-mcp)](https://www.npmjs.com/package/shopware-mcp)
[![CI](https://github.com/bnymnDev/shopware-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bnymnDev/shopware-mcp/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

- **Read-only by default.** Write tools are not even registered unless you pass `--allow-write`.
- **Dry run first.** Every write tool defaults to `dryRun: true` and returns the exact request it would send.
- **Compact JSON.** Tools return only what an agent needs: no `_uniqueIdentifier`, `versionId` or translation blobs.
- **Shopware 6.6+**, Admin API only. One `npx`, no build step.

## Install

Create an **Integration** in your Shopware admin (Settings → System → Integrations), copy the access key ID and secret, then:

```bash
npx shopware-mcp                       # stdio (default)
npx shopware-mcp --http --port 3333    # Streamable HTTP on http://127.0.0.1:3333/mcp
npx shopware-mcp --allow-write         # also register the guarded write tools
```

### Claude Desktop

`claude_desktop_config.json`:

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
| `SHOPWARE_MCP_LOG_LEVEL` | no | `error` (default), `warn`, `info`, `debug`. Logs go to stderr only |

CLI flags override the environment: `--allow-write`, `--http`, `--port <n>`, `--host <addr>`, `--log-level <level>`.

The Integration needs read permissions on the entities you want to query (product, order, customer, category, promotion, plugin, sales channel, currency, language) and write permissions on product, order and promotion for the write tools. Granting the integration the *Administrator* role is the quick path for a dev shop; use a dedicated role in production.

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
| [`stock_set`](docs/tools.md#stock_set) | write (guarded) | Set stock (guarded) |
| [`product_update`](docs/tools.md#product_update) | write (guarded) | Update product (guarded) |
| [`order_state_transition`](docs/tools.md#order_state_transition) | write (guarded) | Transition order state (guarded) |
| [`promotion_toggle`](docs/tools.md#promotion_toggle) | write (guarded) | Toggle promotion (guarded) |
<!-- TOOLS:END -->

Full parameter reference: [docs/tools.md](docs/tools.md). Every search tool takes `{ term?, filter?, sort?, page?, limit?, fields? }` and returns `{ total, page, limit, items }`. Filters map 1:1 to Shopware Criteria filters, so anything you can filter in the Admin API works here too.

Resources: `shopware://shop`, `shopware://sales-channels`. Prompts: `order_summary`, `low_stock_report`.

## Safety

- Without `--allow-write` (or `SHOPWARE_MCP_ALLOW_WRITE=true`) the server exposes read tools only. Agents cannot discover or call write tools.
- Write tools (`stock_set`, `product_update`, `order_state_transition`, `promotion_toggle`) default to `dryRun: true` and return `{ dryRun: true, wouldSend: { method, url, body } }` without touching the shop. Real writes return the re-fetched entity.
- `product_update` only touches name, description, active and one currency's price. Nothing else is writable.
- The HTTP transport has no authentication layer in v0.1. Bind it to localhost (the default) or put it behind a reverse proxy that authenticates.
- Secrets are never logged and never appear in error messages. Errors come back as `{ error: { status, code, detail } }`.

## Development

```bash
pnpm install
pnpm dev          # stdio server via tsx
pnpm test         # vitest + msw-mocked Admin API
pnpm build        # tsup → dist/
pnpm inspect      # MCP Inspector against dist/
pnpm docs:tools   # regenerate docs/tools.md + the table above
```

End-to-end tests against a real Shopware (`dockware/dev`) run with `pnpm test:e2e`; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Need custom Shopware agents or plugins?

This connector is open source and MIT licensed. If you need custom agent workflows, Shopware plugins, multi-shop setups or a hosted variant with audit logs, get in touch: [github.com/bnymnDev](https://github.com/bnymnDev).

## License

[MIT](LICENSE)
