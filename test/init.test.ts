import { describe, expect, it } from "vitest";
import { defaultConfigPath, mergeHostConfig, snippetFor } from "../src/init.js";

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
