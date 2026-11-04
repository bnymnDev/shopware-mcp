# Where shopware-mcp is listed, and how to list it

Two ways to run it, and the directories that take each:

- **Local** (`npx shopware-mcp`, the Docker image, the `.mcpb` bundle): the shop's keys stay
  on the user's machine.
- **Hosted** (`https://p-h07rka.project.space/mcp`, `shopware-mcp hosted`): nothing to install,
  the person connects their shop with an Integration's keys on the first use (OAuth).
  Read-only. The big assistant directories only take this kind.

| Directory | Kind | Status | What it takes |
|---|---|---|---|
| Official MCP Registry | local | listed | `pnpm release:local` publishes every release (`server.json`) |
| VS Code, GitHub MCP Registry | local | listed | read from the official registry |
| npm | local | listed | `pnpm release:local` with `NPM_TOKEN` |
| Antigravity / Gemini CLI extensions | local | ready | `gemini-extension.json` in the repository root and the repository topic `gemini-cli-extension`; the gallery picks it up |
| Docker MCP Catalog | local, remote | files ready | a pull request, see below |
| Smithery | local, remote | ready | one command, see below |
| Cline Marketplace | local | text ready | an issue, see below |
| awesome-mcp-servers | local | line ready | a pull request, see below |
| Glama | local | automatic | indexes public MCP repositories; claim it at glama.ai/mcp/servers |
| mcp.so, PulseMCP, MCP Market | local | ready | their submit forms take the repository URL |
| Claude Connectors Directory | hosted | ready | claude.ai/directory/manage, see below |
| ChatGPT apps directory | hosted | ready | platform.openai.com, see below |
| Agensi (agent skills) | skill | ready | `skills/shopware-shop-manager/SKILL.md`, see below |

## Docker MCP Catalog

1. Fork `github.com/docker/mcp-registry`.
2. Copy `docker-local/server.yaml` to `servers/shopware/server.yaml` and set `source.commit` to
   the commit of the release tag (already set to the 0.11.1 release commit; `git rev-list -n 1 v0.11.1` for later ones). Docker builds the image from
   the repository's `Dockerfile`.
3. Copy the three files of `docker-remote/` to `servers/shopware-remote/`.
4. Open one pull request per server and fill in Docker's form for test credentials: a demo
   shop's URL and a read-only Integration.

## Smithery

```bash
npx -y @smithery/cli@latest login
npx -y @smithery/cli@latest mcp publish https://p-h07rka.project.space/mcp   # hosted
npx -y @smithery/cli@latest mcp publish ./shopware-mcp.mcpb                    # local bundle
```

The bundle is attached to every GitHub release, and the hosted server serves the current one at
`https://p-h07rka.project.space/shopware-mcp.mcpb`.

## Cline Marketplace

New issue at `github.com/cline/mcp-marketplace` with the logo `docs/brand/icon-400.png`:

> **Repository:** https://github.com/bnymnDev/shopware-mcp
>
> **Logo:** attached (400×400 PNG)
>
> **Why it is useful:** Shopware 6 runs a large part of European e-commerce. shopware-mcp lets
> Cline answer "is the shop okay?", find why orders stopped, check campaign codes before Black
> Friday and report sales, through the Admin API. Read-only by default; writes are dry runs
> first. Installs with `npx -y shopware-mcp`, configured by three environment variables
> (`SHOPWARE_URL`, `SHOPWARE_CLIENT_ID`, `SHOPWARE_CLIENT_SECRET`); `npx shopware-mcp setup`
> creates a least-privilege Integration.

## awesome-mcp-servers

In `README.md` of `github.com/punkpeye/awesome-mcp-servers`, section **Commerce**:

```markdown
- [bnymnDev/shopware-mcp](https://github.com/bnymnDev/shopware-mcp) 📇 ☁️ 🏠 - Shopware 6 Admin API: health audit, live order pulse, why-are-there-no-orders diagnosis, campaign checks, sales reports. Read-only by default, writes are dry runs first.
```

## Claude Connectors Directory

At claude.ai/directory/manage (any paid Claude plan):

- Server URL: `https://p-h07rka.project.space/mcp`, OAuth with dynamic client registration.
- Every tool carries `readOnlyHint` and a title.
- Privacy: the server stores the shop address and the Integration's keys, sealed with
  AES-256-GCM, and tokens only as hashes; nothing else. Write it up as a privacy page before
  submitting.
- Test account: a demo shop and a read-only Integration for the reviewers.

## ChatGPT apps directory

At platform.openai.com (verified developer): the same server URL; the pulse, the audit, the
brief and the sales report come with MCP Apps pages that ChatGPT shows inline. The directory
asks for test prompts and a short demo video; `docs/video/` has one.

## Agensi

Agensi sells and lists skills for Claude, Codex, Cursor and Gemini; there was no Shopware skill
when this was written. `skills/shopware-shop-manager/SKILL.md` walks an assistant through the
morning check, the no-orders diagnosis, campaign preparation, EU duties, agent readiness and
updates with shopware-mcp's tools. Switch on creator mode at agensi.io/dashboard#settings, then
submit the folder; free brings users to the server, a price needs payouts connected.
