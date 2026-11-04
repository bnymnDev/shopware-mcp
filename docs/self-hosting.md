# Self-hosting

## Transports

| Mode | Command | Use when |
|---|---|---|
| stdio (default) | `npx shopware-mcp` | The MCP host starts the server itself (Claude Desktop, Claude Code, Cursor). |
| Streamable HTTP | `npx shopware-mcp --http --port 3333` | Several hosts share one server, or the host only speaks HTTP. Endpoint: `/mcp`. Health: `/healthz`. |
| Hosted, many shops | `npx shopware-mcp hosted --port 3333` | A public server for anyone: each person connects their own shop through OAuth. Read-only. See [Hosted mode](#hosted-mode). |

The HTTP transport runs **stateless**: every request gets a fresh MCP server instance, there are no sessions to expire, and it can sit behind any load balancer.

## Authentication

`--http` authenticates callers with one static bearer token, or not at all:

- Set `SHOPWARE_MCP_HTTP_TOKEN` to a random secret of at least 16 characters (`openssl rand -hex 24`). Every request to `/mcp` must then carry `Authorization: Bearer <secret>`; anything else gets a 401. `/healthz` stays open so load balancers can probe. Most HTTP-capable hosts have a headers field for this.
- Without a token, anyone who can reach the port can query (and, with `--allow-write`, modify) your shop. Default bind is `127.0.0.1`; only pass `--host 0.0.0.0` inside a container or a private network. The server logs a warning when it listens beyond loopback without a token.
- On loopback the server rejects requests whose `Host` header is not a loopback name (DNS-rebinding protection).
- For anything reachable from the outside, a reverse proxy with its own authentication (Caddy or nginx with basic auth, an OAuth proxy, your API gateway) is still the right place for user management, rate limits and TLS. Forward `/mcp` and `/healthz`, and make sure the proxy does not buffer responses: MCP uses server-sent events (`Content-Type: text/event-stream`). For nginx that is `proxy_buffering off;`.

Requests to Shopware time out after `SHOPWARE_MCP_TIMEOUT_MS` (default 30 seconds), so a shop that stops answering fails one tool call with `TIMEOUT` instead of hanging the session.

Example Caddyfile:

```
mcp.example.com {
  basicauth {
    agent $2a$14$...   # caddy hash-password
  }
  reverse_proxy 127.0.0.1:3333 {
    flush_interval -1
  }
}
```

## Docker

The image is published for `linux/amd64` and `linux/arm64`, so it runs natively on Apple Silicon and ARM servers.

```bash
docker run --rm -p 3333:3333 \
  -e SHOPWARE_URL=https://shop.example.com \
  -e SHOPWARE_CLIENT_ID=SWIA... \
  -e SHOPWARE_CLIENT_SECRET=... \
  ghcr.io/bnymndev/shopware-mcp
```

The default command is `--http --host 0.0.0.0 --port 3333`. Add `--allow-write` to enable write tools:

```bash
docker run --rm -p 3333:3333 -e ... ghcr.io/bnymndev/shopware-mcp --http --host 0.0.0.0 --port 3333 --allow-write
```

stdio inside Docker (for hosts that spawn a process):

```json
{
  "command": "docker",
  "args": ["run", "-i", "--rm", "-e", "SHOPWARE_URL", "-e", "SHOPWARE_CLIENT_ID", "-e", "SHOPWARE_CLIENT_SECRET", "ghcr.io/bnymndev/shopware-mcp", "--log-level", "error"]
}
```

Passing any argument replaces the default `--http ...` command, so the example above runs stdio.

Build locally: `docker build -t shopware-mcp .`

## Hosted mode

`shopware-mcp hosted` serves many shops from one address, the way Claude, ChatGPT and other
assistants add a connector: the person pastes the server's URL, the assistant opens a page
where they enter their shop's address and an Integration's keys, and from then on the
assistant holds a token for that shop.

```bash
docker run -d -p 3333:3333 -v shopware-mcp:/data \
  -e SHOPWARE_MCP_PUBLIC_URL=https://mcp.example.com \
  -e SHOPWARE_MCP_SECRET_KEY=$(openssl rand -hex 32) \
  ghcr.io/bnymndev/shopware-mcp hosted --host 0.0.0.0 --port 3333
```

| Variable | Notes |
|---|---|
| `SHOPWARE_MCP_PUBLIC_URL` | The https address in front of the server; it is the OAuth issuer and the resource the tokens are for |
| `SHOPWARE_MCP_SECRET_KEY` | 32 bytes (`openssl rand -hex 32`) that seal the stored Integration keys. Keep it: without it, every connected shop has to connect again |
| `SHOPWARE_MCP_DATA_DIR` | Where clients, connections and token hashes live (the image uses `/data`; mount a volume) |
| `SHOPWARE_MCP_SITE_DIR` | A folder served under `/`; the image ships the website there |

What it implements, as the MCP authorization spec of 2025-11-25 asks:

- Discovery: a 401 on `/mcp` points to `/.well-known/oauth-protected-resource`, which names
  this server as the authorization server (`/.well-known/oauth-authorization-server`).
- Clients: dynamic registration (`/register`) and client ID metadata documents (an https
  `client_id`). Public clients only, with PKCE S256; a redirect URI must be https, a loopback
  address or an app's own scheme, and the server never redirects to one a client did not
  register.
- Tokens: access tokens live an hour, refresh tokens 30 days and rotate on use; codes are
  single-use and expire after ten minutes. `/revoke` ends a token early.
- Storage: one JSON file with the Integration keys sealed by AES-256-GCM and every token only as
  its SHA-256. A copy of the file hands out no access.
- The consent page checks the keys against the shop before anything is stored, and the server
  refuses shop addresses on private networks (no requests into the network it runs in).
- Read-only, always: write tools are not registered in hosted mode.

Put TLS in front (the image speaks plain HTTP) and do not buffer `/mcp` (server-sent events).

## Releasing without CI

Everything the release workflow does also runs from a laptop: `pnpm verify` runs every check CI
runs, and `pnpm release:local` turns pending changesets into a version, tags it, and publishes
npm (with `NPM_TOKEN`), the GitHub release with the `.mcpb` bundle, the multi-platform image on
GHCR and the MCP registry entry (with `GITHUB_TOKEN`). Each step checks first whether its part is
out already, so a second run repairs a release that stopped halfway; `--only=docker,registry`
runs single steps. Where Docker Hub limits anonymous pulls, set
`NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine`, the same image from a mirror.

## Checking a deployment

`shopware-mcp doctor` (with the same environment as the server) reports the connection, the integration's role and, per tool, whether it will work. `--json` prints the report as JSON for a health dashboard; the exit code is 1 when a read tool is blocked. Set `SHOPWARE_MCP_MAX_WRITES` on shared deployments so one runaway agent cannot perform more than a known number of real writes per process.

## Shopware permissions

The short way: `npx shopware-mcp setup` logs in as an admin once, creates a role with exactly the privileges below and an integration using it, shows the new secret, and verifies both with the doctor. Run it again with `--rotate` after an upgrade and it sets the role to what the tools now need, naming each privilege it adds or removes; `--dry-run` prints the list and the changes without creating anything. Setup only updates a role it created itself, and it sends the admin password over https only, or plain http to this machine.

The list was measured, not guessed: every tool ran against a role that started with nothing, and each privilege Shopware reported missing was added until none was. Shopware checks every association a request loads, which is why reading an order also needs `order_customer:read` and `state_machine_state:read`.

Read-only role (45 privileges): `api_proxy_switch-customer`, `category:read`, `country:read`, `currency:read`, `customer:read`, `customer_address:read`, `customer_group:read`, `delivery_time:read`, `document:read`, `document_base_config:read`, `document_type:read`, `integration:read`, `language:read`, `locale:read`, `media:read`, `order:read`, `order_address:read`, `order_customer:read`, `order_delivery:read`, `order_line_item:read`, `order_transaction:read`, `payment_method:read`, `plugin:read`, `product:read`, `product_manufacturer:read`, `product_media:read`, `product_review:read`, `product_search_keyword:read`, `product_visibility:read`, `promotion:read`, `promotion_discount:read`, `promotion_individual_code:read`, `promotion_sales_channel:read`, `property_group:read`, `property_group_option:read`, `rule:read`, `sales_channel:read`, `sales_channel_domain:read`, `sales_channel_type:read`, `scheduled_task:read`, `shipping_method:read`, `state_machine_history:read`, `state_machine_state:read`, `tax:read`, `user:read`.

`api_proxy_switch-customer` lets `checkout_simulate` log a throwaway cart in as a customer; without it the tool still simulates guests. `promotion_individual_code:read` and `promotion_sales_channel:read` let it explain why a code was refused. `user:read` and `integration:read` let `order_history` name who made a transition; they also let the integration read admin user names and email addresses, and integration labels, though never passwords or secrets.

With `--allow-write` (25 more): `customer:update`, `customer_tag:create`, `customer_tag:delete`, `document:create`, `media:create`, `media_default_folder:read`, `media_folder:read`, `order:update`, `order_delivery:update`, `order_tag:create`, `order_tag:delete`, `order_transaction:update`, `product:create`, `product:update`, `product_media:create`, `product_review:update`, `product_tag:create`, `product_tag:delete`, `product_visibility:create`, `promotion:create`, `promotion:update`, `promotion_discount:create`, `promotion_sales_channel:create`, `tag:create`, `tag:read`.

Three privileges are never granted by default. `system_config:read` lets `shop_settings` work and the audit check legal pages, but it reads every setting, SMTP passwords and payment keys included, although the tool only ever shows a scrubbed part; pass `--settings` if you want it. `system.plugin_maintain` lets `plugins_list` show available updates, but it also allows installing and updating extensions; pass `--plugin-updates` if you want it. Administrator rights are never needed. Without the first two, the audit reports those checks as not covered by the role instead of failing. Plugin-aware tools bring their own: with FroshTools installed, setup adds `frosh_tools:read`, `frosh_tools_queue:read` and `frosh_tools_security:read`; with the Merqo plugins it adds read access to their returns, e-invoice and cart snapshot entities.

`shopware-mcp doctor` reports per tool what an existing integration's role allows.

## Local Shopware for testing

`docker compose -f docker-compose.e2e.yml up -d --wait` starts `dockware/dev` on port 8000 (admin `admin` / `shopware`). The e2e suite creates its own Integration through the Admin API; see `e2e/`.

## Operations

- Logs: stderr only, prefixed `[shopware-mcp]`. `SHOPWARE_MCP_LOG_LEVEL=debug` logs every request as method, path, status and duration. Bodies and tokens are never logged.
- Tokens: OAuth2 client-credentials, cached in memory and refreshed 60 s before expiry; a 401 triggers exactly one refresh and retry.
- Limits: `limit` is capped at 50 per page; use `page` to paginate.

## Scheduled audits

`shopware-mcp audit` and `shopware-mcp report` need only the three environment variables and print Markdown (or JSON with `--json`). The audit exits with 1 when a critical finding exists, or with `--fail-on warning` when any warning exists, so a cron job or a CI step can alert on it:

```bash
SHOPWARE_URL=… SHOPWARE_CLIENT_ID=… SHOPWARE_CLIENT_SECRET=… npx shopware-mcp audit --fail-on warning > audit.md || send-alert audit.md
```

The Docker image runs it too: `docker run --rm -e SHOPWARE_URL=… -e SHOPWARE_CLIENT_ID=… -e SHOPWARE_CLIENT_SECRET=… ghcr.io/bnymndev/shopware-mcp audit`.

