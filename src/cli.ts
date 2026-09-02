import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ShopwareClient } from "./client/index.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { type LogLevel, logger, setLogLevel } from "./logger.js";
import { createServer } from "./server.js";
import { startHttp } from "./transport/http.js";
import { NAME, VERSION } from "./version.js";

const HELP = `${NAME} ${VERSION} — MCP server for the Shopware 6 Admin API

Usage:
  shopware-mcp [options]

Options:
  --allow-write        Register write tools (stock_set, product_update, ...). Default: read-only.
  --http               Serve Streamable HTTP on /mcp instead of stdio.
  --port <n>           HTTP port (default 3333).
  --host <host>        HTTP bind address (default 127.0.0.1).
  --log-level <level>  error | warn | info | debug (stderr only).
  -h, --help           Show this help.
  -v, --version        Print the version.

Environment:
  SHOPWARE_URL, SHOPWARE_CLIENT_ID, SHOPWARE_CLIENT_SECRET   (required)
  SHOPWARE_MCP_ALLOW_WRITE, SHOPWARE_MCP_DEFAULT_LIMIT, SHOPWARE_MCP_LOG_LEVEL
`;

export interface CliOptions {
  allowWrite: boolean | undefined;
  http: boolean;
  port: number;
  host: string;
  logLevel: LogLevel | undefined;
  help: boolean;
  version: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      "allow-write": { type: "boolean" },
      http: { type: "boolean", default: false },
      port: { type: "string", default: "3333" },
      host: { type: "string", default: "127.0.0.1" },
      "log-level": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const port = Number.parseInt(values.port ?? "3333", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }
  const level = values["log-level"];
  if (level !== undefined && !["error", "warn", "info", "debug"].includes(level)) {
    throw new Error(`Invalid --log-level: ${level}`);
  }
  return {
    allowWrite: values["allow-write"],
    http: values.http ?? false,
    port,
    host: values.host ?? "127.0.0.1",
    logLevel: level as LogLevel | undefined,
    help: values.help ?? false,
    version: values.version ?? false,
  };
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

  let config: Config;
  try {
    config = loadConfig(process.env, { allowWrite: cli.allowWrite, logLevel: cli.logLevel });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\n${HELP}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  setLogLevel(config.logLevel);
  const ctx = { client: new ShopwareClient(config), config };
  logger.info("starting", {
    version: VERSION,
    shop: config.url,
    allowWrite: config.allowWrite,
    transport: cli.http ? "http" : "stdio",
  });

  if (cli.http) {
    const httpServer = await startHttp(ctx, { port: cli.port, host: cli.host });
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
