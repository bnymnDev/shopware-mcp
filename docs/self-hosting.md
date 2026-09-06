# Self-hosting

## Transports

| Mode | Command | Use when |
|---|---|---|
| stdio (default) | `npx shopware-mcp` | The MCP host starts the server itself (Claude Desktop, Claude Code, Cursor). |
| Streamable HTTP | `npx shopware-mcp --http --port 3333` | Several hosts share one server, or the host only speaks HTTP. Endpoint: `/mcp`. Health: `/healthz`. |

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

## Checking a deployment

`shopware-mcp doctor` (with the same environment as the server) reports the connection, the integration's role and, per tool, whether it will work. `--json` prints the report as JSON for a health dashboard; the exit code is 1 when a read tool is blocked. Set `SHOPWARE_MCP_MAX_WRITES` on shared deployments so one runaway agent cannot perform more than a known number of real writes per process.

## Shopware permissions

Create a dedicated Integration and role. Minimal read role: `product`, `product_manufacturer`, `category`, `order`, `order_line_item`, `order_transaction`, `order_delivery`, `customer`, `customer_address`, `promotion`, `promotion_discount`, `plugin`, `sales_channel`, `currency`, `language`, `payment_method` (viewer). For `plugins_list` upgrade information the integration additionally needs the `system:plugin:maintain` privilege; without it the tool still works and reports a warning.

Write tools additionally need editor rights on `product` (stock, basic fields), `order` (state transitions) and `promotion`.

## Local Shopware for testing

`docker compose -f docker-compose.e2e.yml up -d --wait` starts `dockware/dev` on port 8000 (admin `admin` / `shopware`). The e2e suite creates its own Integration through the Admin API; see `e2e/`.

## Operations

- Logs: stderr only, prefixed `[shopware-mcp]`. `SHOPWARE_MCP_LOG_LEVEL=debug` logs every request as method, path, status and duration. Bodies and tokens are never logged.
- Tokens: OAuth2 client-credentials, cached in memory and refreshed 60 s before expiry; a 401 triggers exactly one refresh and retry.
- Limits: `limit` is capped at 50 per page; use `page` to paginate.
