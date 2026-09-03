# Security policy

shopware-mcp talks to your shop with the credentials you give it. Please report anything that could
leak those credentials, bypass the read-only default or expose data that the tools promise to strip.

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability).
Do not open a public issue for security problems. You will get an acknowledgement within a few days.

## Scope

- Credential handling (OAuth token cache, logging, error messages)
- The `--allow-write` gate and `dryRun` defaults
- Secret scrubbing in `entity_search` and the blocked entity list
- The HTTP transport's Host header check

Out of scope: Shopware itself, and deployments that expose the HTTP transport without a proxy despite
the documentation.

## Hardening tips

- Give the Integration a read-only role unless you need write tools.
- Keep the HTTP transport on localhost or behind an authenticating reverse proxy.
- Pin the npm version in production and review the changelog before upgrading.
