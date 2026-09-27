import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  auditSlackText,
  briefSlackText,
  buildBrief,
  formatBriefMarkdown,
  postWebhook,
  renderAuditHtml,
  renderBriefHtml,
  renderSalesHtml,
} from "./brief.js";
import { ShopwareClient } from "./client/index.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { formatAuditMarkdown, formatSalesReportMarkdown } from "./format.js";
import { defaultConfigPath, HOSTS, type Host, mergeHostConfig, snippetFor } from "./init.js";
import { type LogLevel, logger, setLogLevel } from "./logger.js";
import { createServer } from "./server.js";
import {
  AdminSession,
  applySetup,
  planSetup,
  type SetupOptions,
  type SetupResult,
  toolsLeftOut,
} from "./setup.js";
import { runAudit } from "./tools/audit.js";
import { defaultTimeZone, isTimeZone } from "./tools/pulse.js";
import { buildSalesReport } from "./tools/reports.js";
import { fetchShopInfo } from "./tools/shop.js";
import { startHttp } from "./transport/http.js";
import { NAME, VERSION } from "./version.js";

const HELP = `${NAME} ${VERSION} — MCP server for the Shopware 6 Admin API

Usage:
  shopware-mcp [options]            Serve MCP (stdio by default)
  shopware-mcp doctor [--json]      Check the connection and which tools this integration can use
  shopware-mcp setup [--url <url>] [--user <name>] [--allow-write] [--for <host> [--write]]
                                    Log in as an admin once and create an integration whose role
                                    has exactly the privileges the tools need, then verify it
  shopware-mcp init [--for <host>] [--write]
                                    Test the credentials and print (or write) the host config
  shopware-mcp audit [--json] [--days <n>] [--threshold <n>] [--fail-on <severity>]
                                    Run the shop audit and print it as Markdown (or JSON)
  shopware-mcp report [--json] [--from <date>] [--to <date>] [--interval <unit>]
                                    Print the sales report of a period as Markdown (or JSON)
  shopware-mcp brief [--json] [--html <file>] [--slack <url>] [--tz <zone>]
                                    The shop right now, the audit and the last 7 days in one
                                    page: Markdown, JSON, or a self-contained HTML file

Options:
  --allow-write        Register write tools (stock_set, product_update, ...). Default: read-only.
  --max-writes <n>     Refuse real writes beyond n per process (0 = no cap).
  --no-extensions      Do not detect installed extensions or register plugin-aware tools.
  --http               Serve Streamable HTTP on /mcp instead of stdio.
  --port <n>           HTTP port (default 3333).
  --host <host>        HTTP bind address (default 127.0.0.1).
  --log-level <level>  error | warn | info | debug (stderr only).
  --for <host>         init, setup: claude-desktop | claude-code | cursor | vscode | windsurf | gemini | codex | zed
  --write              init, setup: merge the entry into the host's config file (backup kept)
  --url <url>          setup: shop URL (or SHOPWARE_URL)
  --user <name>        setup: admin user name (or SHOPWARE_ADMIN_USER; default admin)
  --name <label>       setup: integration label, the role is named after it (default shopware-mcp)
  --rotate             setup: give an existing integration of that name new keys
  --plugin-updates     setup: also grant system.plugin_maintain so plugins_list shows updates
  --settings           setup: also grant system_config:read for shop_settings (it can read every
                       setting, SMTP and payment secrets included; the tool shows a scrubbed part)
  --dry-run            setup: show the role and privileges without creating anything
  --json               doctor, audit, report: print JSON instead of text
  --days <n>           audit: days after which an unshipped or unpaid order counts as stuck (7)
  --threshold <n>      audit: low-stock threshold (5)
  --fail-on <sev>      audit, brief: exit 1 when a finding of this severity exists: critical | warning | none
                       (audit default critical, brief default none; exit 2 when a check failed to run,
                       not when the role leaves a check out on purpose)
  --html <file>        audit, report, brief: also write a self-contained HTML page ("-" for stdout)
  --json-file <file>   audit, report, brief: also write the JSON to a file, next to the Markdown
  --slack <url>        audit, brief: post a short summary to a Slack incoming webhook
  --tz <zone>          brief, audit, report: IANA time zone for days and "today" (default: TZ or
                       the system's); report reads --from/--to as local days in it
  --from, --to <date>  report: period, ISO dates (default: the last 30 days)
  --interval <unit>    report: day (default) | week | month
  -h, --help           Show this help.
  -v, --version        Print the version.

Environment:
  SHOPWARE_URL, SHOPWARE_CLIENT_ID, SHOPWARE_CLIENT_SECRET   (required)
  SHOPWARE_MCP_ALLOW_WRITE, SHOPWARE_MCP_MAX_WRITES, SHOPWARE_MCP_DEFAULT_LIMIT
  SHOPWARE_LANGUAGE_ID, SHOPWARE_MCP_EXTENSIONS, SHOPWARE_MCP_TIMEOUT_MS, SHOPWARE_MCP_LOG_LEVEL
  SHOPWARE_MCP_HTTP_TOKEN   bearer token required on /mcp when serving --http
  SHOPWARE_ADMIN_USER, SHOPWARE_ADMIN_PASSWORD             setup only; never stored
`;

const COMMANDS = ["serve", "doctor", "init", "setup", "audit", "report", "brief"] as const;
const SEVERITIES = ["critical", "warning", "none"] as const;
const INTERVALS = ["day", "week", "month"] as const;
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
  days: number;
  threshold: number;
  failOn: (typeof SEVERITIES)[number] | undefined;
  html: string | undefined;
  jsonFile: string | undefined;
  slack: string | undefined;
  tz: string | undefined;
  from: string | undefined;
  to: string | undefined;
  interval: (typeof INTERVALS)[number];
  url: string | undefined;
  user: string | undefined;
  name: string;
  rotate: boolean;
  pluginUpdates: boolean;
  settings: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
}

function positiveInt(
  name: string,
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid --${name}: ${value} (1 to ${max})`);
  }
  return parsed;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function isoDateOption(name: string, value: string | undefined): string | undefined {
  if (value !== undefined && !ISO_DATE.test(value)) {
    throw new Error(`Invalid --${name}: ${value} (use an ISO date like 2026-08-01)`);
  }
  return value;
}

function webhookOption(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid --slack: not a URL");
  }
  if (url.protocol !== "https:") throw new Error("Invalid --slack: the webhook must use https");
  return value;
}

function timeZoneOption(value: string | undefined): string | undefined {
  if (value !== undefined && !isTimeZone(value)) throw new Error(`Invalid --tz: ${value}`);
  return value;
}

function labelOption(value: string | undefined): string {
  if (value === undefined) return "shopware-mcp";
  const label = value.trim();
  if (!/^[\w .:()-]{1,64}$/u.test(label)) {
    throw new Error(`Invalid --name: ${value} (letters, digits, spaces and .:()- only)`);
  }
  return label;
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
      days: { type: "string" },
      threshold: { type: "string" },
      "fail-on": { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      interval: { type: "string" },
      url: { type: "string" },
      user: { type: "string" },
      name: { type: "string" },
      rotate: { type: "boolean", default: false },
      "plugin-updates": { type: "boolean", default: false },
      settings: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      html: { type: "string" },
      "json-file": { type: "string" },
      slack: { type: "string" },
      tz: { type: "string" },
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
  const failOn = values["fail-on"];
  if (failOn !== undefined && !SEVERITIES.includes(failOn as (typeof SEVERITIES)[number])) {
    throw new Error(`Invalid --fail-on: ${failOn} (use ${SEVERITIES.join(", ")})`);
  }
  const interval = values.interval ?? "day";
  if (!INTERVALS.includes(interval as (typeof INTERVALS)[number])) {
    throw new Error(`Invalid --interval: ${interval} (use ${INTERVALS.join(", ")})`);
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
    days: positiveInt("days", values.days, 7, 365),
    threshold: positiveInt("threshold", values.threshold, 5, 10_000),
    failOn: failOn as (typeof SEVERITIES)[number] | undefined,
    html: values.html,
    jsonFile: values["json-file"],
    slack: webhookOption(values.slack),
    tz: timeZoneOption(values.tz),
    from: isoDateOption("from", values.from),
    to: isoDateOption("to", values.to),
    interval: interval as (typeof INTERVALS)[number],
    url: values.url,
    user: values.user,
    name: labelOption(values.name),
    rotate: values.rotate ?? false,
    pluginUpdates: values["plugin-updates"] ?? false,
    settings: values.settings ?? false,
    dryRun: values["dry-run"] ?? false,
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

  await deliverHostConfig(cli, { url, clientId, clientSecret, allowWrite });
}

/** Print the host snippet, or merge it into the host's config file with --write. */
async function deliverHostConfig(
  cli: CliOptions,
  input: { url: string; clientId: string; clientSecret: string; allowWrite: boolean },
): Promise<void> {
  const out = (text: string) => process.stderr.write(text);
  let host = cli.for;
  if (!host) {
    const menu = HOSTS.map((name, index) => `  ${index + 1}) ${name}`).join("\n");
    const answer = await ask(`Which host?\n${menu}\nChoice [1]: `).catch(() => "1");
    const index = Number.parseInt(answer || "1", 10) - 1;
    host = HOSTS[index] ?? "claude-desktop";
  }
  const snippet = snippetFor(host, input);
  const target = defaultConfigPath(host);

  if (cli.write && target && host !== "zed") {
    const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    const merged = mergeHostConfig(existing, host, input);
    // The file holds the secret: new files (and backups) are readable by the owner only.
    if (existing !== undefined) {
      const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      writeFileSync(backup, existing, { mode: 0o600 });
      out(`Backup written to ${backup}\n`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
    }
    writeFileSync(target, merged, { mode: 0o600 });
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

/** Read a password without echoing it; only on a terminal. */
async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error(
      "The admin password is required: set SHOPWARE_ADMIN_PASSWORD when not interactive",
    );
  }
  process.stderr.write(question);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish(new Error("No password entered"));
    const onData = (chunk: string) => {
      // Arrow keys and other escape sequences arrive as one chunk; they are not part of it.
      if (chunk.startsWith("\u001b")) return;
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

/** The admin password must not cross the network in the clear; a local shop is the exception. */
export function checkSetupUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid shop URL: ${value}`);
  }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$|\.localhost$/i.test(url.hostname);
  if (url.protocol === "http:" && !local) {
    throw new Error(
      `Refusing to send the admin password over plain http to ${url.host}; use https (http is only allowed for localhost)`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid shop URL: ${value}`);
  }
  return value;
}

/**
 * `shopware-mcp setup`: one admin login creates a role with exactly the privileges the tools
 * need and an integration that uses it, verifies it with the doctor and hands over the config.
 */
async function runSetup(cli: CliOptions): Promise<void> {
  const out = (text: string) => process.stderr.write(text);
  const url = checkSetupUrl(
    (cli.url ?? (await ask("Shop URL (https://shop.example.com): ", process.env.SHOPWARE_URL)))
      .replace(/\/+$/, "")
      .replace(/\/api$/i, ""),
  );
  const user =
    cli.user ??
    process.env.SHOPWARE_ADMIN_USER ??
    ((await ask("Admin user name [admin]: ").catch(() => "")) || "admin");
  const password =
    process.env.SHOPWARE_ADMIN_PASSWORD ?? (await askHidden(`Password for ${user}: `));
  const options: SetupOptions = {
    name: cli.name,
    allowWrite: cli.allowWrite ?? false,
    pluginUpdates: cli.pluginUpdates,
    settings: cli.settings,
    rotate: cli.rotate,
  };
  const leftOut = toolsLeftOut(options);

  const session = await AdminSession.login(url, user, password);
  const plan = await planSetup(session, options);
  if (cli.dryRun) {
    if (cli.json) {
      process.stdout.write(`${JSON.stringify({ dryRun: true, ...plan, leftOut }, null, 2)}\n`);
      return;
    }
    const change = plan.role
      ? `update: ${plan.changes.added.length} added, ${plan.changes.removed.length} removed`
      : "create";
    out(`Role         ${plan.roleName} (${change})\n`);
    const linked = plan.role !== null && plan.integration?.roleIds.includes(plan.role.id);
    out(
      `Integration  ${options.name} (${plan.integration ? (options.rotate ? "new keys" : linked ? "exists, keeps its keys" : "exists, pass --rotate") : "create"})\n`,
    );
    out(`Privileges   ${plan.privileges.length}\n`);
    for (const entry of leftOut) out(`Left out     ${entry.tool} (pass ${entry.flag})\n`);
    for (const privilege of plan.changes.removed) out(`Removes      ${privilege}\n`);
    out("\n");
    process.stdout.write(`${plan.privileges.join("\n")}\n`);
    return;
  }
  const result = await applySetup(session, plan, options);
  const credentials = result.credentials;
  if (!credentials) {
    // Only the role changed: the integration keeps its keys, which setup cannot read back.
    if (cli.json) {
      process.stdout.write(`${JSON.stringify({ ...result, leftOut }, null, 2)}\n`);
      return;
    }
    const changes = [
      `${result.role.added.length} added`,
      `${result.role.removed.length} removed${result.role.removed.length > 0 ? ` (${result.role.removed.join(", ")})` : ""}`,
    ].join(", ");
    out(
      `Role         Updated "${result.role.name}": ${result.role.privileges} privileges, ${changes}\n`,
    );
    out(`Integration  "${result.integration.label}" keeps its keys\n`);
    for (const entry of leftOut)
      out(`  – ${entry.tool}: left out, pass ${entry.flag} to include it\n`);
    out("\nRun shopware-mcp doctor with its credentials to verify.\n");
    return;
  }

  // From here on the integration exists and its secret lives only in this process: show it
  // before anything else can fail, so no later step can lose it.
  if (!cli.json) {
    const verb = result.role.created ? "Created" : "Updated";
    const changes = [
      result.role.added.length > 0 && !result.role.created
        ? `${result.role.added.length} added`
        : "",
      result.role.removed.length > 0
        ? `${result.role.removed.length} removed (${result.role.removed.join(", ")})`
        : "",
    ].filter(Boolean);
    out(
      `Role         ${verb} "${result.role.name}" with ${result.role.privileges} privileges${changes.length > 0 ? `, ${changes.join(", ")}` : ""}\n`,
    );
    out(
      `Integration  ${result.integration.created ? "Created" : "New keys for"} "${result.integration.label}", not an administrator\n`,
    );
    out(`Access key   ${credentials.clientId}\n`);
    out(`Secret       ${credentials.clientSecret}\n`);
    out("             Shown once. Keep it in the host config, not in a repository.\n\n");
  }

  let ok = false;
  try {
    ok = await verifySetup(cli, url, options, result, credentials, plan.privileges, leftOut);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (cli.json) {
      process.stdout.write(
        `${JSON.stringify({ ...result, doctor: null, error: reason }, null, 2)}\n`,
      );
    } else {
      out(`\nThe integration exists, but verifying it failed: ${reason}\n`);
      out("Use the credentials above, or run setup again with --rotate for new ones.\n");
    }
    process.exitCode = 1;
    return;
  }
  if (cli.json) {
    process.exitCode = ok ? 0 : 1;
    return;
  }
  out("\n");
  try {
    await deliverHostConfig(cli, {
      url,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      allowWrite: options.allowWrite,
    });
  } catch (error) {
    out(
      `Could not write the host config: ${error instanceof Error ? error.message : String(error)}\n` +
        "Add the credentials above to it by hand, or fix the file and run init --write.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.exitCode = ok ? 0 : 1;
}

/** Run the doctor with the new credentials and report; true when every tool it should have is ready. */
async function verifySetup(
  cli: CliOptions,
  url: string,
  options: SetupOptions,
  result: SetupResult,
  credentials: { clientId: string; clientSecret: string },
  privileges: string[],
  leftOut: { tool: string; flag: string }[],
): Promise<boolean> {
  const out = (text: string) => process.stderr.write(text);
  const config = loadConfig(
    {
      SHOPWARE_URL: url,
      SHOPWARE_CLIENT_ID: credentials.clientId,
      SHOPWARE_CLIENT_SECRET: credentials.clientSecret,
    },
    { allowWrite: options.allowWrite, logLevel: "error" },
  );
  const report = await runDoctor(
    { client: new ShopwareClient(config), config },
    { label: result.integration.label, privileges },
  );
  const skipped = new Set(leftOut.map((entry) => entry.tool));
  const relevant = report.tools.filter(
    (entry) => (options.allowWrite || !entry.write) && !skipped.has(entry.tool),
  );
  const ok = report.connection.ok && relevant.every((entry) => entry.status === "ready");
  if (cli.json) {
    process.stdout.write(`${JSON.stringify({ ...result, leftOut, doctor: report }, null, 2)}\n`);
    return ok;
  }
  const reads = relevant.filter((item) => !item.write);
  const writes = relevant.filter((item) => item.write);
  const ready = (items: typeof reads) => items.filter((item) => item.status === "ready").length;
  out(`Shop         ${report.shop?.url ?? url} (Shopware ${report.shop?.version ?? "?"})\n`);
  out(
    `Verified     ${ready(reads)} of ${reads.length} read tools ready` +
      (options.allowWrite ? `, ${ready(writes)} of ${writes.length} write tools ready\n` : "\n"),
  );
  for (const item of relevant.filter((entry) => entry.status !== "ready")) {
    out(`  ✗ ${item.tool}: ${item.detail ?? item.status}\n`);
  }
  for (const entry of leftOut)
    out(`  – ${entry.tool}: left out, pass ${entry.flag} to include it\n`);
  return ok;
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
    try {
      await runInit(cli);
    } catch (error) {
      process.stderr.write(
        `Init failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (cli.command === "setup") {
    setLogLevel(cli.logLevel ?? "error");
    try {
      await runSetup(cli);
    } catch (error) {
      process.stderr.write(
        `Setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
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

  const timeZone = cli.tz ?? defaultTimeZone();
  /** Write HTML to a file, or to stdout for "-" (then it replaces the text output). */
  const writeHtml = (html: string) => {
    if (!cli.html) return;
    if (cli.html === "-") process.stdout.write(html);
    else {
      writeFileSync(cli.html, html);
      process.stderr.write(`Wrote ${cli.html}\n`);
    }
  };
  /** The JSON next to the Markdown, for scripts: the GitHub Action reads its counts from it. */
  const writeJson = (value: unknown) => {
    if (cli.jsonFile) writeFileSync(cli.jsonFile, `${JSON.stringify(value, null, 2)}\n`);
  };
  const notify = async (text: string) => {
    if (!cli.slack) return;
    try {
      await postWebhook(cli.slack, text);
    } catch (error) {
      process.stderr.write(`Slack: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = process.exitCode || 1;
    }
  };
  const failing = (summary: { critical: number; warning: number }, level: CliOptions["failOn"]) =>
    level === "critical"
      ? summary.critical > 0
      : level === "warning"
        ? summary.critical + summary.warning > 0
        : false;

  if (cli.command === "audit") {
    const report = await runAudit(ctx.client, {
      stuckOrderDays: cli.days,
      lowStockThreshold: cli.threshold,
      forecastDays: 14,
      maxItems: 10,
      complianceChecks: true,
      timeZone,
    });
    if (cli.html !== "-") {
      process.stdout.write(
        cli.json ? `${JSON.stringify(report, null, 2)}\n` : formatAuditMarkdown(report),
      );
    }
    writeHtml(renderAuditHtml(report, timeZone));
    writeJson(report);
    // 2 when a check could not run: the report is incomplete, which a cron job should not read as fine.
    process.exitCode = failing(report.summary, cli.failOn ?? "critical")
      ? 1
      : report.warnings && report.warnings.length > 0
        ? 2
        : 0;
    await notify(auditSlackText(report));
    return;
  }

  if (cli.command === "report") {
    const report = await buildSalesReport(ctx.client, {
      from: cli.from,
      to: cli.to,
      interval: cli.interval,
      excludeCancelled: true,
      topProducts: 10,
      compareWithPrevious: true,
      timeZone,
    });
    if (cli.html !== "-") {
      process.stdout.write(
        cli.json ? `${JSON.stringify(report, null, 2)}\n` : formatSalesReportMarkdown(report),
      );
    }
    writeHtml(renderSalesHtml(report, config.url, timeZone));
    writeJson(report);
    return;
  }

  if (cli.command === "brief") {
    const brief = await buildBrief(ctx.client, { timeZone });
    if (cli.html !== "-") {
      process.stdout.write(
        cli.json ? `${JSON.stringify(brief, null, 2)}\n` : formatBriefMarkdown(brief),
      );
    }
    writeHtml(renderBriefHtml(brief));
    writeJson(brief);
    process.exitCode = failing(brief.audit.summary, cli.failOn ?? "none")
      ? 1
      : brief.audit.warnings && brief.audit.warnings.length > 0
        ? 2
        : 0;
    await notify(briefSlackText(brief));
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
