#!/usr/bin/env bash
# Runs the shopware-mcp audit for the GitHub Action in action.yml. Inputs arrive as environment
# variables only, never interpolated into this script. SHOPWARE_MCP_CMD overrides the command
# for local testing.
set -uo pipefail

read -r -a cmd <<< "${SHOPWARE_MCP_CMD:-npx --yes shopware-mcp@${INPUT_VERSION:-latest}}"
args=(audit --fail-on "${INPUT_FAIL_ON:-critical}" --days "${INPUT_DAYS:-7}" --threshold "${INPUT_THRESHOLD:-5}")
if [ -n "${INPUT_HTML:-}" ]; then
  args+=(--html "$INPUT_HTML")
fi

report="${RUNNER_TEMP:-/tmp}/shopware-audit.md"
"${cmd[@]}" "${args[@]}" > "$report"
code=$?

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$report" >> "$GITHUB_STEP_SUMMARY"
else
  cat "$report"
fi

count() {
  grep -m1 -oE "[0-9]+ $1" "$report" | grep -oE '^[0-9]+' || echo 0
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
