import { homedir } from "node:os";
import { join } from "node:path";

export const HOSTS = ["claude-desktop", "claude-code", "cursor", "vscode", "zed"] as const;
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
    case "vscode":
      if (platform === "darwin") return join(support, "Code", "User", "mcp.json");
      if (platform === "win32") return join(appData, "Code", "User", "mcp.json");
      return join(config, "Code", "User", "mcp.json");
    default:
      return null;
  }
}

/** Merge the shopware entry into a host's JSON config, keeping every other server. */
export function mergeHostConfig(
  existing: string | undefined,
  host: Host,
  input: InitInput,
): string {
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
    default:
      return {
        title: "Claude Desktop (claude_desktop_config.json)",
        path: defaultConfigPath(host),
        text: `${JSON.stringify({ mcpServers: { shopware: serverEntry(input) } }, null, 2)}\n`,
      };
  }
}
