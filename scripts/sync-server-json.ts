/**
 * Keeps server.json (MCP registry manifest) and manifest.json (Claude Desktop extension)
 * in sync with package.json. Run automatically by `pnpm release:version`.
 *
 * Usage: pnpm sync:server [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";

interface PackageJson {
  name: string;
  version: string;
  mcpName?: string;
}

const MAX_REGISTRY_DESCRIPTION = 100;

interface ServerJson {
  name: string;
  version: string;
  description: string;
  packages?: { identifier?: string; version?: string }[];
}

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;

function readJson(path: string): { text: string; value: Record<string, unknown> } {
  const text = readFileSync(path, "utf8");
  return { text, value: JSON.parse(text) as Record<string, unknown> };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const problems: string[] = [];
const updates: { path: string; next: string; current: string }[] = [];

// --- server.json (MCP registry) --------------------------------------------------------------
{
  const { text, value } = readJson("server.json");
  const server = value as unknown as ServerJson;
  if (!pkg.mcpName) {
    problems.push(
      'package.json is missing "mcpName"; the MCP registry needs it to verify ownership',
    );
  } else if (server.name !== pkg.mcpName) {
    problems.push(
      `server.json name "${server.name}" must equal package.json mcpName "${pkg.mcpName}"`,
    );
  }
  // The registry answers with a 422 at publish time if the description is any longer.
  if ((server.description ?? "").length > MAX_REGISTRY_DESCRIPTION) {
    problems.push(
      `server.json description is ${server.description.length} characters, the MCP registry allows ${MAX_REGISTRY_DESCRIPTION}`,
    );
  }
  server.version = pkg.version;
  for (const entry of server.packages ?? []) {
    if (entry.identifier === pkg.name) entry.version = pkg.version;
  }
  updates.push({ path: "server.json", next: serialize(server), current: text });
}

// --- manifest.json (Claude Desktop extension) --------------------------------------------------
{
  const { text, value } = readJson("manifest.json");
  value.version = pkg.version;
  updates.push({ path: "manifest.json", next: serialize(value), current: text });
}

if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
  process.exit(1);
}

const stale = updates.filter((update) => update.current !== update.next);

if (process.argv.includes("--check")) {
  if (stale.length > 0) {
    process.stderr.write(
      `Out of sync with package.json@${pkg.version}: ${stale
        .map((update) => update.path)
        .join(", ")}. Run \`pnpm sync:server\`.\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`server.json and manifest.json match package.json@${pkg.version}.\n`);
} else {
  for (const update of stale) writeFileSync(update.path, update.next);
  process.stderr.write(
    stale.length > 0
      ? `Synced to ${pkg.version}: ${stale.map((update) => update.path).join(", ")}.\n`
      : `Already in sync at ${pkg.version}.\n`,
  );
}
