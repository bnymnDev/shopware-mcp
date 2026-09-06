## What

<!-- One or two sentences: what changes and why. Link the issue if there is one. -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] Touched a tool? `pnpm docs:tools` was run so `docs/tools.md` and both README tables are in sync
- [ ] Edited a transcript under `docs/demo/`? `pnpm docs:demos` was run
- [ ] User-facing change? A changeset was added with `pnpm changeset`
- [ ] New dependency? The reason is explained above
- [ ] Write tools stay behind `--allow-write` and default to `dryRun: true`; no secrets in logs or errors
