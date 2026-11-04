---
"shopware-mcp": minor
---

Ready for AI shoppers, the next Shopware version and assistants without installing anything.

- `agent_readiness` checks the product feed AI shopping agents read (Agentic Commerce feed fields, as Google Merchant): required fields, GTIN check digits, weight, HTTPS and the policy pages an agent checkout links to. `shopware-mcp feed --out feed.jsonl` writes the whole feed.
- `update_check` reads Shopware's update service: the next version and the security issues it fixes, the requirement checks, and per extension whether it works with that version. Setup grants its privilege with `--plugin-updates`.
- `shop_brief` puts the pulse, the audit and the last seven days into one tool. In hosts that show MCP Apps, the brief, the pulse, the audit and the sales report open as interactive pages.
- Audit rule packs: `gpsr`, `eaa` and `feeds`, via `rulePacks`, `--rules gpsr,eaa` or `SHOPWARE_MCP_RULES`.
- `shopware-mcp hosted` serves many shops behind OAuth 2.1 (PKCE, dynamic client registration, client ID metadata documents, rotating refresh tokens), with Integration keys sealed by AES-256-GCM. Read-only. The Docker image also serves the website.
- `pnpm verify` and `pnpm release:local` release without a CI service; the Dockerfile takes `NODE_IMAGE` for a registry mirror. `gemini-extension.json` lists the server in the Gemini and Antigravity CLI extension gallery.
