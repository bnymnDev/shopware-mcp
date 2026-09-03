# Contributing

Thanks for helping make Shopware agent-friendly. Small, focused pull requests are easiest to review.

## Setup

```bash
pnpm install
cp .env.example .env   # point it at a dev shop (dockware works well)
pnpm dev               # stdio server via tsx
pnpm test              # unit tests (msw-mocked Admin API)
pnpm lint && pnpm typecheck
```

`pnpm inspect` opens the MCP Inspector against the built server (`pnpm build` first).

## Ground rules

- **Keep the scope tight.** Payment integrations, multi-shop routing, hosted variants with audit logs and bulk import/migration tooling are out of scope for this repo.
- Every tool has a zod input schema, an LLM-oriented description and a test with an msw mock of the Shopware response (`test/fixtures/`).
- Search tools use the Criteria API (`POST /api/search/<entity>`), cap `limit` at 50 and always return `total`.
- Return only what an agent needs; strip `_uniqueIdentifier`, `versionId`, translated blobs and `customFields` (unless requested via `fields`).
- Write tools must be gated behind `--allow-write` and default to `dryRun: true`.
- Never log secrets or put tokens in error messages.
- Adding a dependency? Say why in the PR description.

## Workflow

1. Branch from `main`.
2. Make the change, add or update tests, run `pnpm lint && pnpm typecheck && pnpm test`.
3. If you touched a tool, run `pnpm docs:tools` so `docs/tools.md` and the README table stay in sync (CI checks this).
4. Add a changeset for user-facing changes: `pnpm changeset`.
5. Open the PR with a conventional-commit style title (`feat:`, `fix:`, `docs:`, ...).

## End-to-end tests

`pnpm test:e2e` runs against a real Shopware in Docker (`dockware/dev`). See `docs/self-hosting.md` for the compose setup; CI runs these nightly.

## Releasing the desktop extension

`pnpm pack:mcpb` builds the self-contained bundle and packs `shopware-mcp.mcpb` from `manifest.json`; the release workflow attaches it to the GitHub release.

## Good first issues

Look for the `good first issue` label. Ideas that fit the roadmap: more `fields` examples in the docs, a `products_search` example gallery, better error hints for common Shopware ACL problems.
