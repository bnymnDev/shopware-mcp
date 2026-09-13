import { describe, expect, it } from "vitest";
import { defaultConfigPath, mergeCodexConfig, mergeHostConfig, snippetFor } from "../src/init.js";

const input = {
  url: "https://shop.test",
  clientId: "SWIATEST",
  clientSecret: "secret",
  allowWrite: false,
};

describe("init snippets", () => {
  it("renders a Claude Code command and JSON for the file-based hosts", () => {
    expect(snippetFor("claude-code", input).text).toContain("-e SHOPWARE_URL=https://shop.test");
    expect(snippetFor("claude-code", input).text).toContain("-- npx -y shopware-mcp");
    const desktop = JSON.parse(snippetFor("claude-desktop", input).text);
    expect(desktop.mcpServers.shopware).toEqual({
      command: "npx",
      args: ["-y", "shopware-mcp"],
      env: {
        SHOPWARE_URL: "https://shop.test",
        SHOPWARE_CLIENT_ID: "SWIATEST",
        SHOPWARE_CLIENT_SECRET: "secret",
      },
    });
    const vscode = JSON.parse(snippetFor("vscode", input).text);
    expect(vscode.servers.shopware.command).toBe("npx");
    const zed = JSON.parse(snippetFor("zed", input).text);
    expect(zed.context_servers.shopware.source).toBe("custom");
    const writable = JSON.parse(snippetFor("cursor", { ...input, allowWrite: true }).text);
    expect(writable.mcpServers.shopware.env.SHOPWARE_MCP_ALLOW_WRITE).toBe("true");
  });

  it("renders Windsurf and Gemini JSON and a Codex TOML table", () => {
    expect(JSON.parse(snippetFor("windsurf", input).text).mcpServers.shopware.command).toBe("npx");
    expect(JSON.parse(snippetFor("gemini", input).text).mcpServers.shopware.env.SHOPWARE_URL).toBe(
      "https://shop.test",
    );
    const codex = snippetFor("codex", { ...input, clientSecret: 'se"c\\ret', allowWrite: true });
    expect(codex.path).toMatch(/\.codex\/config\.toml$/);
    expect(codex.text).toBe(
      [
        "[mcp_servers.shopware]",
        'command = "npx"',
        'args = ["-y", "shopware-mcp"]',
        'env = { SHOPWARE_URL = "https://shop.test", SHOPWARE_CLIENT_ID = "SWIATEST", ' +
          'SHOPWARE_CLIENT_SECRET = "se\\"c\\\\ret", SHOPWARE_MCP_ALLOW_WRITE = "true" }',
        "",
      ].join("\n"),
    );
  });

  it("replaces the shopware table in a Codex config and keeps the rest", () => {
    const existing = [
      'model = "o3"',
      "",
      "[mcp_servers.shopware]",
      'command = "old"',
      "",
      "[mcp_servers.shopware.env]",
      'SHOPWARE_URL = "https://old.test"',
      "",
      "[mcp_servers.github]",
      'command = "gh-mcp"',
      "",
    ].join("\n");
    const merged = mergeCodexConfig(existing, input);
    expect(merged).toContain('model = "o3"');
    expect(merged).toContain('[mcp_servers.github]\ncommand = "gh-mcp"');
    expect(merged).not.toContain("old");
    expect(merged.match(/\[mcp_servers\.shopware\]/g)).toHaveLength(1);
    expect(mergeCodexConfig(undefined, input)).toMatch(/^\[mcp_servers\.shopware\]/);
    expect(mergeCodexConfig('model = "o3"\n', input)).toMatch(/^model = "o3"\n\n\[mcp_servers/);
    expect(mergeHostConfig(existing, "codex", input)).toBe(merged);
  });

  it("merges into an existing config without touching other servers", () => {
    const existing = JSON.stringify({
      mcpServers: { github: { command: "gh-mcp" }, shopware: { command: "old" } },
      theme: "dark",
    });
    const merged = JSON.parse(mergeHostConfig(existing, "claude-desktop", input));
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(merged.mcpServers.shopware.command).toBe("npx");
    expect(JSON.parse(mergeHostConfig(undefined, "vscode", input)).servers.shopware).toBeDefined();
    expect(() => mergeHostConfig("[]", "cursor", input)).toThrow(/JSON object/);
  });

  it("knows where each host keeps its config", () => {
    const home = "/home/me";
    expect(defaultConfigPath("claude-desktop", "darwin", home, {})).toBe(
      "/home/me/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(defaultConfigPath("claude-desktop", "linux", home, {})).toBe(
      "/home/me/.config/Claude/claude_desktop_config.json",
    );
    expect(
      defaultConfigPath("claude-desktop", "win32", home, {
        APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      }),
    ).toContain("claude_desktop_config.json");
    expect(defaultConfigPath("cursor", "linux", home, {})).toBe("/home/me/.cursor/mcp.json");
    expect(defaultConfigPath("vscode", "linux", home, {})).toBe(
      "/home/me/.config/Code/User/mcp.json",
    );
    expect(defaultConfigPath("claude-code", "linux", home, {})).toBeNull();
    expect(defaultConfigPath("zed", "linux", home, {})).toBeNull();
  });
});

describe("Codex config edge cases", () => {
  const input = {
    url: "https://shop.test",
    clientId: "SWIATEST",
    clientSecret: "s",
    allowWrite: false,
  };

  it("recognises spaced headers, trailing comments, sub-tables and CRLF files", () => {
    const existing = [
      'model = "o3"',
      "[ mcp_servers.shopware ] # our shop",
      'command = "old"',
      "[ mcp_servers.shopware.env ]",
      'SHOPWARE_CLIENT_SECRET = "leak"',
      "[mcp_servers.github]",
      'command = "gh-mcp"',
    ].join("\r\n");
    const merged = mergeCodexConfig(existing, input);
    expect(merged).not.toContain("leak");
    expect(merged).not.toContain("old");
    expect(merged.match(/mcp_servers\.shopware/g)).toHaveLength(1);
    expect(merged).toContain('[mcp_servers.github]\ncommand = "gh-mcp"');
    expect(merged).not.toContain("\r");
  });

  it("replaces a table that is last in the file and escapes control characters", () => {
    const merged = mergeCodexConfig('[mcp_servers.shopware]\ncommand = "old"\n', input);
    expect(merged).toBe(mergeCodexConfig(undefined, input));
    expect(mergeCodexConfig(undefined, { ...input, clientSecret: "a\nb" })).toContain(
      'SHOPWARE_CLIENT_SECRET = "a\\u000ab"',
    );
  });
});
