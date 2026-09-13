import { homedir } from "node:os";
import { join } from "node:path";

export const HOSTS = [
  "claude-desktop",
  "claude-code",
  "cursor",
  "vscode",
  "windsurf",
  "gemini",
  "codex",
  "zed",
] as const;
export type Host = (typeof HOSTS)[number];

export interface InitInput {
  url: string;
  clientId: string;
  clientSecret: string;
  allowWrite: boolean;
}

export interface Snippet {
  title: string;
  /** Where the snippet belongs, or null when it is a command. */
  path: string | null;
  text: string;
}

function envBlock(input: InitInput): Record<string, string> {
  return {
    SHOPWARE_URL: input.url,
    SHOPWARE_CLIENT_ID: input.clientId,
    SHOPWARE_CLIENT_SECRET: input.clientSecret,
    ...(input.allowWrite ? { SHOPWARE_MCP_ALLOW_WRITE: "true" } : {}),
  };
}

/** The server entry every JSON-configured host understands. */
export function serverEntry(input: InitInput): Record<string, unknown> {
  return { command: "npx", args: ["-y", "shopware-mcp"], env: envBlock(input) };
}

/** Default location of the host's user-level config file, or null when there is none to write. */
export function defaultConfigPath(
  host: Host,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const support = join(home, "Library", "Application Support");
  const config = env.XDG_CONFIG_HOME ?? join(home, ".config");
  switch (host) {
    case "claude-desktop":
      if (platform === "darwin") return join(support, "Claude", "claude_desktop_config.json");
      if (platform === "win32") return join(appData, "Claude", "claude_desktop_config.json");
      return join(config, "Claude", "claude_desktop_config.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "windsurf":
      return join(home, ".codeium", "windsurf", "mcp_config.json");
    case "gemini":
      return join(home, ".gemini", "settings.json");
    case "codex":
      return join(home, ".codex", "config.toml");
    case "vscode":
      if (platform === "darwin") return join(support, "Code", "User", "mcp.json");
      if (platform === "win32") return join(appData, "Code", "User", "mcp.json");
      return join(config, "Code", "User", "mcp.json");
    default:
      return null;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: TOML needs them escaped
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;

const tomlString = (value: string): string =>
  `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(
      CONTROL_CHARACTERS,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )}"`;

/** `[mcp_servers.shopware]`, with any spacing or trailing comment; group 1 set for sub-tables. */
const SHOPWARE_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*shopware(\s*\.\s*[\w.-]+)?\s*\]\s*(#.*)?$/;

/** The `[mcp_servers.shopware]` table Codex CLI reads from config.toml. */
export function codexBlock(input: InitInput): string {
  const env = Object.entries(envBlock(input))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ");
  return [
    "[mcp_servers.shopware]",
    'command = "npx"',
    'args = ["-y", "shopware-mcp"]',
    `env = { ${env} }`,
    "",
  ].join("\n");
}

/**
 * Replace or append the shopware table in a Codex config without a TOML parser: the table runs
 * from its header to the next top-level header, and everything else is kept byte for byte.
 */
export function mergeCodexConfig(existing: string | undefined, input: InitInput): string {
  const block = codexBlock(input);
  const text = existing ?? "";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = SHOPWARE_TABLE.exec(line);
    return match !== null && !match[1];
  });
  if (start === -1) {
    const trimmed = text.trimEnd();
    return trimmed ? `${trimmed}\n\n${block}` : block;
  }
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trimStart().startsWith("[") && !SHOPWARE_TABLE.test(line)) break;
    end++;
  }
  const before = lines.slice(0, start).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trimStart();
  return `${before ? `${before}\n\n` : ""}${block}${after ? `\n${after}` : ""}`;
}

/** Merge the shopware entry into a host's config, keeping every other server. */
export function mergeHostConfig(
  existing: string | undefined,
  host: Host,
  input: InitInput,
): string {
  if (host === "codex") return mergeCodexConfig(existing, input);
  let parsed: Record<string, unknown> = {};
  if (existing?.trim()) {
    const value: unknown = JSON.parse(existing);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The existing config is not a JSON object");
    }
    parsed = value as Record<string, unknown>;
  }
  const key = host === "vscode" ? "servers" : "mcpServers";
  const servers =
    parsed[key] && typeof parsed[key] === "object" && !Array.isArray(parsed[key])
      ? (parsed[key] as Record<string, unknown>)
      : {};
  parsed[key] = { ...servers, shopware: serverEntry(input) };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function snippetFor(host: Host, input: InitInput): Snippet {
  const env = envBlock(input);
  switch (host) {
    case "claude-code": {
      const flags = Object.entries(env)
        .map(([key, value]) => `  -e ${key}=${value} \\`)
        .join("\n");
      return {
        title: "Claude Code",
        path: null,
        text: `claude mcp add shopware \\\n${flags}\n  -- npx -y shopware-mcp\n`,
      };
    }
    case "zed":
      return {
        title: "Zed (settings.json)",
        path: defaultConfigPath(host),
        text: `${JSON.stringify(
          { context_servers: { shopware: { source: "custom", ...serverEntry(input) } } },
          null,
          2,
        )}\n`,
      };
    case "vscode":
      return {
        title: "VS Code (mcp.json)",
        path: defaultConfigPath(host),
        text: `${JSON.stringify({ servers: { shopware: serverEntry(input) } }, null, 2)}\n`,
      };
    case "cursor":
      return {
        title: "Cursor (mcp.json)",
        path: defaultConfigPath(host),
        text: `${JSON.stringify({ mcpServers: { shopware: serverEntry(input) } }, null, 2)}\n`,
      };
    case "windsurf":
      return {
        title: "Windsurf (mcp_config.json)",
        path: defaultConfigPath(host),
        text: `${JSON.stringify({ mcpServers: { shopware: serverEntry(input) } }, null, 2)}\n`,
      };
    case "gemini":
      return {
        title: "Gemini CLI (settings.json)",
        path: defaultConfigPath(host),
        text: `${JSON.stringify({ mcpServers: { shopware: serverEntry(input) } }, null, 2)}\n`,
      };
    case "codex":
      return {
        title: "Codex CLI (config.toml)",
        path: defaultConfigPath(host),
        text: codexBlock(input),
      };
    default:
      return {
        title: "Claude Desktop (claude_desktop_config.json)",
        path: defaultConfigPath(host),
        text: `${JSON.stringify({ mcpServers: { shopware: serverEntry(input) } }, null, 2)}\n`,
      };
  }
}
