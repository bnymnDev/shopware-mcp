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

Without Docker it also works natively, which is useful in restricted environments: install MariaDB
and PHP with the usual Shopware extensions, `composer create-project shopware/production:^6.7`,
`bin/console system:install --basic-setup`, then serve it with `php -S 127.0.0.1:8000 -t public
public/index.php` and point `SHOPWARE_URL` at it. The suite creates its own integration through the
Admin API. Extension tools are exercised only when the matching plugins are installed, so the run
stays green on a plain shop.

## Releasing

Releases are automated. You never publish by hand.

1. Add a changeset with your change: `pnpm changeset`.
2. When it lands on `main`, the Release workflow opens a "chore: release" pull request that bumps the version and updates the changelog. `pnpm release:version` also syncs `server.json` and `manifest.json` to the new version.
3. Merging that pull request publishes everything in one run: the npm package (with provenance), a GitHub release with the `shopware-mcp.mcpb` desktop extension attached, the `ghcr.io` image, and the entry in the [MCP registry](https://registry.modelcontextprotocol.io) via GitHub OIDC.

The version pull request needs "Allow GitHub Actions to create and approve pull requests" under
Settings, Actions, General, Workflow permissions. Without it the workflow reports that Actions may
not create pull requests, and a maintainer can instead run `pnpm release:version` locally and push,
which publishes on the next run.

The workflow refuses to publish while the repository is private, and CI verifies that `docs/tools.md`, `server.json` and `manifest.json` are in sync with the code and the version.

`pnpm pack:mcpb` builds the self-contained bundle and packs `shopware-mcp.mcpb` locally if you want to test the desktop extension before a release.

## Good first issues

Look for the `good first issue` label. Ideas that fit the roadmap: more `fields` examples in the docs, a `products_search` example gallery, better error hints for common Shopware ACL problems.
