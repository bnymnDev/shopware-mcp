import { z } from "zod";
import type { LogLevel } from "./logger.js";

/** Hard cap for `limit` on every search tool. */
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

const boolFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return TRUE_VALUES.has(value.trim().toLowerCase());
}, z.boolean());

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envSchema = z.object({
  SHOPWARE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: "SHOPWARE_URL is required, e.g. https://shop.example.com" })
      .trim()
      .regex(/^https?:\/\/.+/, "SHOPWARE_URL must start with http:// or https://")
      .transform((value) => value.replace(/\/+$/, "")),
  ),
  SHOPWARE_CLIENT_ID: z.preprocess(
    emptyToUndefined,
    z.string({ error: "SHOPWARE_CLIENT_ID is required (Integration access key ID)" }).trim(),
  ),
  SHOPWARE_CLIENT_SECRET: z.preprocess(
    emptyToUndefined,
    z.string({ error: "SHOPWARE_CLIENT_SECRET is required (Integration secret access key)" }),
  ),
  SHOPWARE_MCP_ALLOW_WRITE: boolFromEnv,
  SHOPWARE_MCP_DEFAULT_LIMIT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  ),
  SHOPWARE_MCP_LOG_LEVEL: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.preprocess(emptyToUndefined, z.enum(["error", "warn", "info", "debug"]).default("error")),
  ),
});

export interface Config {
  /** Base URL without trailing slash. */
  url: string;
  clientId: string;
  clientSecret: string;
  /** When false, write tools are not registered at all. */
  allowWrite: boolean;
  defaultLimit: number;
  maxLimit: number;
  logLevel: LogLevel;
}

export interface ConfigOverrides {
  allowWrite?: boolean;
  logLevel?: LogLevel;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Parse configuration from environment variables. CLI flags are passed as `overrides`
 * and take precedence over the environment.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: ConfigOverrides = {},
): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new ConfigError(issues);
  }
  const values = parsed.data;
  return {
    url: values.SHOPWARE_URL,
    clientId: values.SHOPWARE_CLIENT_ID,
    clientSecret: values.SHOPWARE_CLIENT_SECRET,
    allowWrite: overrides.allowWrite ?? values.SHOPWARE_MCP_ALLOW_WRITE,
    defaultLimit: values.SHOPWARE_MCP_DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
    logLevel: overrides.logLevel ?? values.SHOPWARE_MCP_LOG_LEVEL,
  };
}
