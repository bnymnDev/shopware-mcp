import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ShopwareClient } from "./client/index.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { defaultConfigPath, HOSTS, type Host, mergeHostConfig, snippetFor } from "./init.js";
import { type LogLevel, logger, setLogLevel } from "./logger.js";
import { createServer } from "./server.js";
import { fetchShopInfo } from "./tools/shop.js";
import { startHttp } from "./transport/http.js";
import { NAME, VERSION } from "./version.js";

const HELP = `${NAME} ${VERSION} — MCP server for the Shopware 6 Admin API

Usage:
  shopware-mcp [options]            Serve MCP (stdio by default)
  shopware-mcp doctor [--json]      Check the connection and which tools this integration can use
  shopware-mcp init [--for <host>] [--write]
                                    Test the credentials and print (or write) the host config

Options:
  --allow-write        Register write tools (stock_set, product_update, ...). Default: read-only.
  --max-writes <n>     Refuse real writes beyond n per process (0 = no cap).
  --no-extensions      Do not detect installed extensions or register plugin-aware tools.
  --http               Serve Streamable HTTP on /mcp instead of stdio.
  --port <n>           HTTP port (default 3333).
  --host <host>        HTTP bind address (default 127.0.0.1).
  --log-level <level>  error | warn | info | debug (stderr only).
  --for <host>         init: claude-desktop | claude-code | cursor | vscode | zed
  --write              init: merge the entry into the host's config file (backup kept)
  --json               doctor: print the report as JSON
  -h, --help           Show this help.
  -v, --version        Print the version.

Environment:
  SHOPWARE_URL, SHOPWARE_CLIENT_ID, SHOPWARE_CLIENT_SECRET   (required)
  SHOPWARE_MCP_ALLOW_WRITE, SHOPWARE_MCP_MAX_WRITES, SHOPWARE_MCP_DEFAULT_LIMIT
  SHOPWARE_LANGUAGE_ID, SHOPWARE_MCP_EXTENSIONS, SHOPWARE_MCP_TIMEOUT_MS, SHOPWARE_MCP_LOG_LEVEL
  SHOPWARE_MCP_HTTP_TOKEN   bearer token required on /mcp when serving --http
`;

const COMMANDS = ["serve", "doctor", "init"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliOptions {
  command: Command;
  allowWrite: boolean | undefined;
  maxWrites: number | undefined;
  extensions: boolean | undefined;
  http: boolean;
  port: number;
  host: string;
  logLevel: LogLevel | undefined;
  for: Host | undefined;
  write: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "allow-write": { type: "boolean" },
      "max-writes": { type: "string" },
      "no-extensions": { type: "boolean" },
      http: { type: "boolean", default: false },
      port: { type: "string", default: "3333" },
      host: { type: "string", default: "127.0.0.1" },
      "log-level": { type: "string" },
      for: { type: "string" },
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new Error(`Unexpected arguments: ${positionals.join(" ")}`);
  const command = (positionals[0] ?? "serve") as Command;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}`);
  const port = Number.parseInt(values.port ?? "3333", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }
  const level = values["log-level"];
  if (level !== undefined && !["error", "warn", "info", "debug"].includes(level)) {
    throw new Error(`Invalid --log-level: ${level}`);
  }
  let maxWrites: number | undefined;
  if (values["max-writes"] !== undefined) {
    maxWrites = Number.parseInt(values["max-writes"], 10);
    if (!Number.isInteger(maxWrites) || maxWrites < 0) {
      throw new Error(`Invalid --max-writes: ${values["max-writes"]}`);
    }
  }
  const target = values.for;
  if (target !== undefined && !HOSTS.includes(target as Host)) {
    throw new Error(`Invalid --for: ${target} (use ${HOSTS.join(", ")})`);
  }
  return {
    command,
    allowWrite: values["allow-write"],
    maxWrites,
    extensions: values["no-extensions"] ? false : undefined,
    http: values.http ?? false,
    port,
    host: values.host ?? "127.0.0.1",
    logLevel: level as LogLevel | undefined,
    for: target as Host | undefined,
    write: values.write ?? false,
    json: values.json ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

function loadOrExplain(cli: CliOptions): Config | undefined {
  try {
    return loadConfig(process.env, {
      allowWrite: cli.allowWrite,
      maxWrites: cli.maxWrites,
      extensions: cli.extensions,
      logLevel: cli.logLevel,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\n${HELP}`);
      process.exitCode = 2;
      return undefined;
    }
    throw error;
  }
}

async function ask(question: string, fallback?: string): Promise<string> {
  if (fallback) return fallback;
  if (!process.stdin.isTTY) {
    throw new Error(
      `${question.trim()} is required (set it in the environment when not interactive)`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** `shopware-mcp init`: test the credentials, then print or write the host configuration. */
async function runInit(cli: CliOptions): Promise<void> {
  const out = (text: string) => process.stderr.write(text);
  const url = (await ask("Shop URL (https://shop.example.com): ", process.env.SHOPWARE_URL))
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
  const clientId = await ask("Integration access key ID: ", process.env.SHOPWARE_CLIENT_ID);
  const clientSecret = await ask(
    "Integration secret access key: ",
    process.env.SHOPWARE_CLIENT_SECRET,
  );
  const allowWrite = cli.allowWrite ?? false;
  if (!url || !clientId || !clientSecret) {
    out("URL, access key ID and secret are all required.\n");
    process.exitCode = 2;
    return;
  }

  const client = new ShopwareClient({ url, clientId, clientSecret });
  try {
    const info = await fetchShopInfo(client);
    out(`Connected: Shopware ${info.version ?? "?"} ${info.edition ?? ""} at ${info.url}\n\n`);
  } catch (error) {
    out(`Could not connect: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  let host = cli.for;
  if (!host) {
    const menu = HOSTS.map((name, index) => `  ${index + 1}) ${name}`).join("\n");
    const answer = await ask(`Which host?\n${menu}\nChoice [1]: `).catch(() => "1");
    const index = Number.parseInt(answer || "1", 10) - 1;
    host = HOSTS[index] ?? "claude-desktop";
  }
  const snippet = snippetFor(host, { url, clientId, clientSecret, allowWrite });
  const target = defaultConfigPath(host);

  if (cli.write && target && host !== "zed") {
    const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    const merged = mergeHostConfig(existing, host, { url, clientId, clientSecret, allowWrite });
    if (existing !== undefined) {
      const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      writeFileSync(backup, existing);
      out(`Backup written to ${backup}\n`);
    }
    writeFileSync(target, merged);
    out(
      `Wrote the shopware entry to ${target}. Restart ${snippet.title.split(" (")[0]} to load it.\n`,
    );
    return;
  }

  out(`${snippet.title}${snippet.path ? ` → ${snippet.path}` : ""}\n\n`);
  process.stdout.write(snippet.text);
  if (target && host !== "zed") {
    out(`\nRun again with --write to merge this into ${target} (a backup is kept).\n`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let cli: CliOptions;
  try {
    cli = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (cli.help) {
    process.stderr.write(HELP);
    return;
  }
  if (cli.version) {
    process.stderr.write(`${VERSION}\n`);
    return;
  }
  if (cli.command === "init") {
    setLogLevel(cli.logLevel ?? "error");
    await runInit(cli);
    return;
  }

  const config = loadOrExplain(cli);
  if (!config) return;
  setLogLevel(config.logLevel);
  const ctx = { client: new ShopwareClient(config), config };

  if (cli.command === "doctor") {
    const report = await runDoctor(ctx);
    process.stdout.write(
      cli.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report, config.url),
    );
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  logger.info("starting", {
    version: VERSION,
    shop: config.url,
    allowWrite: config.allowWrite,
    transport: cli.http ? "http" : "stdio",
  });

  if (cli.http) {
    const httpServer = await startHttp(ctx, {
      port: cli.port,
      host: cli.host,
      token: config.httpToken,
    });
    const shutdown = () => {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.debug("stdio transport connected");
}
