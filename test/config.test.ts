import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = {
  SHOPWARE_URL: "https://shop.example.com/",
  SHOPWARE_CLIENT_ID: "SWIA123",
  SHOPWARE_CLIENT_SECRET: "s3cret",
};

describe("loadConfig", () => {
  it("parses required vars and strips trailing slashes", () => {
    const config = loadConfig(base);
    expect(config.url).toBe("https://shop.example.com");
    expect(config.clientId).toBe("SWIA123");
    expect(config.allowWrite).toBe(false);
    expect(config.defaultLimit).toBe(20);
    expect(config.maxLimit).toBe(50);
    expect(config.logLevel).toBe("error");
  });

  it("lists every missing variable in one error", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ SHOPWARE_URL: "" });
    } catch (error) {
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("SHOPWARE_URL");
      expect(issues).toContain("SHOPWARE_CLIENT_ID");
      expect(issues).toContain("SHOPWARE_CLIENT_SECRET");
    }
  });

  it("drops a trailing /api from the base URL", () => {
    expect(loadConfig({ ...base, SHOPWARE_URL: "https://shop.example.com/api/" }).url).toBe(
      "https://shop.example.com",
    );
    expect(loadConfig({ ...base, SHOPWARE_URL: "https://shop.example.com/API" }).url).toBe(
      "https://shop.example.com",
    );
  });

  it("rejects URLs without scheme", () => {
    expect(() => loadConfig({ ...base, SHOPWARE_URL: "shop.example.com" })).toThrow(/http/);
  });

  it("parses booleans and limits", () => {
    expect(loadConfig({ ...base, SHOPWARE_MCP_ALLOW_WRITE: "true" }).allowWrite).toBe(true);
    expect(loadConfig({ ...base, SHOPWARE_MCP_ALLOW_WRITE: "1" }).allowWrite).toBe(true);
    expect(loadConfig({ ...base, SHOPWARE_MCP_ALLOW_WRITE: "no" }).allowWrite).toBe(false);
    expect(loadConfig({ ...base, SHOPWARE_MCP_DEFAULT_LIMIT: "35" }).defaultLimit).toBe(35);
    expect(loadConfig({ ...base, SHOPWARE_MCP_DEFAULT_LIMIT: "" }).defaultLimit).toBe(20);
    expect(() => loadConfig({ ...base, SHOPWARE_MCP_DEFAULT_LIMIT: "500" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, SHOPWARE_MCP_LOG_LEVEL: "DEBUG" }).logLevel).toBe("debug");
    expect(() => loadConfig({ ...base, SHOPWARE_MCP_LOG_LEVEL: "loud" })).toThrow(ConfigError);
  });

  it("parses the request timeout and the HTTP token", () => {
    expect(loadConfig(base).timeoutMs).toBe(30_000);
    expect(loadConfig(base).httpToken).toBeUndefined();
    expect(loadConfig({ ...base, SHOPWARE_MCP_TIMEOUT_MS: "5000" }).timeoutMs).toBe(5000);
    expect(() => loadConfig({ ...base, SHOPWARE_MCP_TIMEOUT_MS: "10" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, SHOPWARE_MCP_HTTP_TOKEN: " 0123456789abcdef " }).httpToken).toBe(
      "0123456789abcdef",
    );
    expect(loadConfig({ ...base, SHOPWARE_MCP_HTTP_TOKEN: "" }).httpToken).toBeUndefined();
    expect(() => loadConfig({ ...base, SHOPWARE_MCP_HTTP_TOKEN: "short" })).toThrow(/16/);
  });

  it("lets CLI overrides win over env", () => {
    const config = loadConfig({ ...base, SHOPWARE_MCP_ALLOW_WRITE: "false" }, { allowWrite: true });
    expect(config.allowWrite).toBe(true);
    expect(loadConfig(base, { logLevel: "info" }).logLevel).toBe("info");
  });
});
