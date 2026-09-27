#!/usr/bin/env bash
# Runs the shopware-mcp audit for the GitHub Action in action.yml. Inputs arrive as environment
# variables only, never interpolated into this script. SHOPWARE_MCP_CMD overrides the command
# for local testing.
set -uo pipefail

# The version defaults to the one this action was released with, so pinning the action to a tag
# also pins the code that receives the shop's secret.
version="${INPUT_VERSION:-}"
if [ -z "$version" ]; then
  version="$(node -p 'require(process.argv[1]).version' "${GITHUB_ACTION_PATH:-.}/package.json" 2>/dev/null || true)"
fi
if ! [[ "$version" =~ ^(latest|[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$ ]]; then
  echo "::error::Invalid version '${version}': use latest or a release like 0.8.0" >&2
  exit 2
fi

if [ -n "${SHOPWARE_MCP_CMD:-}" ]; then
  read -r -a cmd <<< "$SHOPWARE_MCP_CMD"
else
  cmd=(npx --yes "shopware-mcp@${version}")
fi

report="${RUNNER_TEMP:-/tmp}/shopware-audit.md"
json="${RUNNER_TEMP:-/tmp}/shopware-audit.json"
rm -f "$json"
args=(audit --fail-on "${INPUT_FAIL_ON:-critical}" --days "${INPUT_DAYS:-7}" --threshold "${INPUT_THRESHOLD:-5}" --json-file "$json")
if [ -n "${INPUT_HTML:-}" ]; then
  args+=(--html "$INPUT_HTML")
fi

"${cmd[@]}" "${args[@]}" > "$report"
code=$?

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$report" >> "$GITHUB_STEP_SUMMARY"
else
  cat "$report"
fi

# Counts come from the JSON report, never from the Markdown's wording.
count() {
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(r.summary?.[process.argv[2]] ?? 0));' "$json" "$1" 2>/dev/null || echo 0
}
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "critical=$(count critical)"
    echo "warning=$(count warning)"
    echo "info=$(count info)"
    echo "exit-code=$code"
  } >> "$GITHUB_OUTPUT"
fi

exit "$code"
