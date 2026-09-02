/**
 * Minimal stderr logger. stdout is reserved for the MCP stdio transport, so nothing in this
 * package may ever write to stdout. Never pass secrets (tokens, client secrets) as `meta`.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel: LogLevel = "error";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] > ORDER[currentLevel]) return;
  const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  process.stderr.write(`[shopware-mcp] ${level}: ${message}${suffix}\n`);
}

export const logger = {
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
};
