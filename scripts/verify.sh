#!/usr/bin/env bash
# Everything CI checks, run on this machine: lint, types, tests, build, generated files and a
# smoke test of the CLI. A release only goes out after this passed.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

step "lint" && pnpm -s lint
step "typecheck" && pnpm -s typecheck
step "unit tests" && pnpm -s test
step "build" && pnpm -s build
step "generated files" && {
  pnpm -s docs:tools --check
  pnpm -s docs:demos --check
  pnpm -s sync:server --check
}
step "smoke test" && {
  node dist/index.js --help >/dev/null
  node dist/bundle/index.js --version
}
if [ "${SHOPWARE_E2E:-}" = "1" ]; then
  step "end-to-end against ${SHOPWARE_URL:-http://localhost:8000}" && pnpm -s test:e2e
fi
printf '\n\033[32m✓ all checks passed\033[0m\n'
