// Stands in for `shopware-mcp audit` in the action test: Markdown on stdout whose wording would
// mislead a grep, the real counts in the JSON file, and the exit code of a critical finding.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args[args.indexOf("--json-file") + 1];
if (file) {
  writeFileSync(file, JSON.stringify({ summary: { critical: 2, warning: 1, info: 4 } }));
}
process.stdout.write(
  `# Shop audit\n\n- 30 critical seconds of downtime were noticed\nargs: ${args.join(" ")}\n`,
);
process.exitCode = 1;
