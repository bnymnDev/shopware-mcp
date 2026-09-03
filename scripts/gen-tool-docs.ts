/**
 * Generates docs/tools.md and the tool table in README.md from the tool definitions.
 * Usage: pnpm docs:tools [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { extensionPacks } from "../src/extensions/index.js";
import { tools } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/tools/types.js";

const README = "README.md";
const TOOLS_DOC = "docs/tools.md";
const START = "<!-- TOOLS:START -->";
const END = "<!-- TOOLS:END -->";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  const?: unknown;
};

function typeOf(schema: JsonSchema): string {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const types = variants.map(typeOf).filter((type) => type !== "null");
    return [...new Set(types)].join(" | ");
  }
  if (schema.type === "array") {
    const inner = schema.items ? typeOf(schema.items) : "any";
    return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
  }
  if (schema.type === "object") {
    if (!schema.properties) return "object";
    const inner = Object.entries(schema.properties)
      .map(([key, value]) => `${key}${schema.required?.includes(key) ? "" : "?"}: ${typeOf(value)}`)
      .join(", ");
    return `{ ${inner} }`;
  }
  if (Array.isArray(schema.type)) return schema.type.filter((type) => type !== "null").join(" | ");
  return schema.type ?? "any";
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function constraintsOf(prop: JsonSchema): string[] {
  const constraints: string[] = [];
  if (prop.default !== undefined) constraints.push(`default \`${JSON.stringify(prop.default)}\``);
  if (prop.minimum !== undefined && prop.minimum > Number.MIN_SAFE_INTEGER) {
    constraints.push(`min ${prop.minimum}`);
  }
  if (prop.maximum !== undefined && prop.maximum < Number.MAX_SAFE_INTEGER) {
    constraints.push(`max ${prop.maximum}`);
  }
  return constraints;
}

function paramTable(tool: ToolDefinition): string {
  const schema = z.toJSONSchema(z.object(tool.inputSchema), { io: "input" }) as JsonSchema;
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) return "_No parameters._\n";
  const rows = entries.map(([name, prop]) => {
    const required = schema.required?.includes(name) ? "yes" : "no";
    const description = [prop.description?.replace(/\.$/, "") ?? "", constraintsOf(prop).join(", ")]
      .filter(Boolean)
      .join(". ");
    return `| \`${name}\` | \`${escapeCell(typeOf(prop))}\` | ${required} | ${escapeCell(description)} |`;
  });
  return ["| Parameter | Type | Required | Description |", "|---|---|---|---|", ...rows].join("\n");
}

function summaryTable(): string {
  const rows = tools.map(
    (tool) =>
      `| [\`${tool.name}\`](docs/tools.md#${tool.name}) | ${tool.write ? "write (guarded)" : "read"} | ${escapeCell(tool.title)} |`,
  );
  return ["| Tool | Access | Purpose |", "|---|---|---|", ...rows].join("\n");
}

function extensionSection(): string {
  if (extensionPacks.length === 0) return "";
  const parts: string[] = [
    "## Plugin-aware tools",
    "",
    "These tools are not part of the core set. The server looks up which extensions are installed " +
      "and active, and registers the matching tools on top. A shop without the extension never " +
      "sees them, and detection can be switched off with `--no-extensions`. Support for another " +
      "vendor's extensions is a pull request against `src/extensions/`.",
    "",
  ];
  for (const pack of extensionPacks) {
    parts.push(`### ${pack.label}`, "", `Source: ${pack.url}`, "");
    parts.push("| Tool | Requires | Purpose |", "|---|---|---|");
    for (const entry of pack.tools) {
      parts.push(
        `| \`${entry.tool.name}\` | ${entry.requires.join(", ")} | ${escapeCell(entry.tool.title)} |`,
      );
    }
    parts.push("");
    for (const entry of pack.tools) {
      parts.push(
        `#### ${entry.tool.name}`,
        "",
        `Registered when installed and active: ${entry.requires.join(", ")}.`,
        "",
        entry.tool.description,
        "",
        paramTable(entry.tool),
        "",
      );
    }
  }
  return parts.join("\n");
}

function toolsDoc(): string {
  const sections = tools.map((tool) => {
    const access = tool.write
      ? "**Write tool** — registered only with `--allow-write` / `SHOPWARE_MCP_ALLOW_WRITE=true`. `dryRun` defaults to `true`."
      : "**Read tool** — always registered.";
    return [
      `## ${tool.name}`,
      "",
      `_${tool.title}_`,
      "",
      access,
      "",
      tool.description,
      "",
      "### Input",
      "",
      paramTable(tool),
      "",
    ].join("\n");
  });
  return [
    "# Tools",
    "",
    "_Generated by `pnpm docs:tools` — do not edit by hand._",
    "",
    "All search tools accept the same paging/filter shape and return `{ total, page, limit, items }`. " +
      "`filter` entries map 1:1 to Shopware Criteria filters: " +
      '`{ type: "equals" | "contains" | "range" | "equalsAny", field, value }` ' +
      "(for `range`, `value` is `{ gte?, gt?, lte?, lt? }`). `limit` is capped at 50. " +
      "Errors are returned as `{ error: { status, code, detail } }`.",
    "",
    summaryTable().replace(/\(docs\/tools\.md#/g, "(#"),
    "",
    ...sections,
    extensionSection(),
  ].join("\n");
}

function updateReadme(content: string): string {
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if (start === -1 || end === -1) throw new Error(`README.md is missing ${START} / ${END} markers`);
  return `${content.slice(0, start + START.length)}\n${summaryTable()}\n${content.slice(end)}`;
}

const check = process.argv.includes("--check");
const nextTools = `${toolsDoc()}\n`;
const readme = readFileSync(README, "utf8");
const nextReadme = updateReadme(readme);

let currentTools = "";
try {
  currentTools = readFileSync(TOOLS_DOC, "utf8");
} catch {
  currentTools = "";
}

if (check) {
  const stale: string[] = [];
  if (currentTools !== nextTools) stale.push(TOOLS_DOC);
  if (readme !== nextReadme) stale.push(README);
  if (stale.length > 0) {
    process.stderr.write(
      `Generated docs are stale: ${stale.join(", ")}. Run \`pnpm docs:tools\`.\n`,
    );
    process.exit(1);
  }
  process.stderr.write("Generated docs are up to date.\n");
} else {
  writeFileSync(TOOLS_DOC, nextTools);
  writeFileSync(README, nextReadme);
  process.stderr.write(`Wrote ${TOOLS_DOC} and updated ${README} (${tools.length} tools).\n`);
}
