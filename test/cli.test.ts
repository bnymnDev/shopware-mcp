import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { main, parseCli } from "../src/cli.js";
import { mock, SHOP_URL, searchHandler } from "./helpers/shopware.js";

describe("parseCli", () => {
  it("has safe defaults", () => {
    expect(parseCli([])).toEqual({
      command: "serve",
      allowWrite: undefined,
      maxWrites: undefined,
      extensions: undefined,
      http: false,
      port: 3333,
      host: "127.0.0.1",
      logLevel: undefined,
      for: undefined,
      write: false,
      json: false,
      days: 7,
      threshold: 5,
      failOn: undefined,
      html: undefined,
      slack: undefined,
      tz: undefined,
      from: undefined,
      to: undefined,
      interval: "day",
      url: undefined,
      user: undefined,
      name: "shopware-mcp",
      rotate: false,
      pluginUpdates: false,
      dryRun: false,
      help: false,
      version: false,
    });
  });

  it("parses the audit and report commands", () => {
    expect(
      parseCli(["audit", "--days", "3", "--threshold", "10", "--fail-on", "warning"]),
    ).toMatchObject({
      command: "audit",
      days: 3,
      threshold: 10,
      failOn: "warning",
    });
    expect(
      parseCli([
        "report",
        "--from",
        "2026-08-01",
        "--to",
        "2026-08-31",
        "--interval",
        "week",
        "--json",
      ]),
    ).toMatchObject({
      command: "report",
      from: "2026-08-01",
      to: "2026-08-31",
      interval: "week",
      json: true,
    });
    expect(() => parseCli(["audit", "--fail-on", "info"])).toThrow(/fail-on/);
    expect(() => parseCli(["audit", "--days", "0"])).toThrow(/days/);
    expect(() => parseCli(["report", "--interval", "hour"])).toThrow(/interval/);
  });

  it("parses flags", () => {
    const cli = parseCli([
      "--allow-write",
      "--http",
      "--port",
      "4000",
      "--host",
      "0.0.0.0",
      "--log-level",
      "debug",
    ]);
    expect(cli).toMatchObject({
      allowWrite: true,
      http: true,
      port: 4000,
      host: "0.0.0.0",
      logLevel: "debug",
    });
  });

  it("rejects unknown flags and bad values", () => {
    expect(() => parseCli(["--nope"])).toThrow();
    expect(() => parseCli(["--port", "abc"])).toThrow(/port/);
    expect(() => parseCli(["--log-level", "loud"])).toThrow(/log-level/);
    expect(() => parseCli(["--max-writes", "-3"])).toThrow(/max-writes/);
    expect(() => parseCli(["--for", "emacs"])).toThrow(/--for/);
    expect(() => parseCli(["bogus"])).toThrow(/Unknown command/);
    expect(() => parseCli(["doctor", "init"])).toThrow(/Unexpected/);
  });

  it("parses the setup and brief commands", () => {
    expect(
      parseCli([
        "setup",
        "--url",
        "https://shop.test",
        "--user",
        "ops",
        "--name",
        "Agent (prod)",
        "--allow-write",
        "--rotate",
        "--plugin-updates",
        "--dry-run",
      ]),
    ).toMatchObject({
      command: "setup",
      url: "https://shop.test",
      user: "ops",
      name: "Agent (prod)",
      allowWrite: true,
      rotate: true,
      pluginUpdates: true,
      dryRun: true,
    });
    expect(
      parseCli([
        "brief",
        "--html",
        "brief.html",
        "--slack",
        "https://hooks.slack.com/services/T0/B0/x",
        "--tz",
        "Europe/Berlin",
        "--fail-on",
        "warning",
      ]),
    ).toMatchObject({
      command: "brief",
      html: "brief.html",
      slack: "https://hooks.slack.com/services/T0/B0/x",
      tz: "Europe/Berlin",
      failOn: "warning",
    });
    expect(() => parseCli(["brief", "--slack", "http://hooks.test/x"])).toThrow(/https/);
    expect(() => parseCli(["brief", "--slack", "not a url"])).toThrow(/--slack/);
    expect(() => parseCli(["brief", "--tz", "Mars/Olympus"])).toThrow(/--tz/);
    expect(() => parseCli(["setup", "--name", "x<script>"])).toThrow(/--name/);
  });

  it("parses the doctor and init commands", () => {
    expect(parseCli(["doctor", "--json"])).toMatchObject({ command: "doctor", json: true });
    expect(parseCli(["init", "--for", "cursor", "--write", "--allow-write"])).toMatchObject({
      command: "init",
      for: "cursor",
      write: true,
      allowWrite: true,
    });
    expect(parseCli(["--max-writes", "5"]).maxWrites).toBe(5);
  });
});

describe("audit and report commands", () => {
  const env = {
    SHOPWARE_URL: "https://shop.test",
    SHOPWARE_CLIENT_ID: "SWIATEST",
    SHOPWARE_CLIENT_SECRET: "secret",
  };

  async function run(argv: string[]): Promise<{ out: string; code: number }> {
    const previous = { ...process.env };
    Object.assign(process.env, env);
    process.exitCode = 0;
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await main(argv);
      return { out, code: Number(process.exitCode ?? 0) };
    } finally {
      process.stdout.write = write;
      process.exitCode = 0;
      process.env = previous;
    }
  }

  it("prints the audit as Markdown and exits according to --fail-on", async () => {
    const critical = await run(["audit"]);
    expect(critical.out).toMatch(/^# Shop audit/);
    expect(critical.code).toBe(1);
    expect((await run(["audit", "--fail-on", "none"])).code).toBe(0);
    const json = await run(["audit", "--json", "--fail-on", "warning"]);
    expect(JSON.parse(json.out).summary.checksRun).toBe(17);
    expect(json.code).toBe(1);
  });

  it("exits with 2 when a check could not run", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/promotion`, () =>
        HttpResponse.json({ errors: [{ code: "FRAMEWORK__MISSING_PRIVILEGE" }] }, { status: 403 }),
      ),
      searchHandler({
        order: () => ({ total: 0, data: [] }),
        product: () => ({ total: 0, data: [] }),
        "sales-channel": () => ({ total: 0, data: [] }),
        plugin: () => ({ total: 0, data: [] }),
        "product-review": () => ({ total: 0, data: [] }),
        "order-line-item": () => ({ total: 0, data: [], aggregations: {} }),
      }),
    );
    const result = await run(["audit"]);
    expect(result.out).toContain("## Skipped");
    expect(result.code).toBe(2);
  });

  it("prints the sales report as Markdown or JSON and validates the dates", async () => {
    mock.use(
      searchHandler({
        order: "order-aggregations",
        "order-line-item": "line-item-aggregations",
        product: "products-search",
      }),
    );
    const markdown = await run(["report", "--from", "2024-06-01", "--to", "2024-06-30"]);
    expect(markdown.out).toMatch(/^# Sales report · 2024-06-01 to 2024-06-30/);
    expect(markdown.code).toBe(0);
    const json = await run(["report", "--json", "--interval", "month"]);
    expect(JSON.parse(json.out).period.interval).toBe("month");
    expect(() => parseCli(["report", "--from", "June 1"])).toThrow(/--from/);
    expect(() => parseCli(["audit", "--days", "7abc"])).toThrow(/--days/);
    expect(() => parseCli(["audit", "--threshold", "99999"])).toThrow(/--threshold/);
  });
});

describe("html, brief and slack", () => {
  const env = {
    SHOPWARE_URL: "https://shop.test",
    SHOPWARE_CLIENT_ID: "SWIATEST",
    SHOPWARE_CLIENT_SECRET: "secret",
  };

  async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
    const previous = { ...process.env };
    Object.assign(process.env, env);
    process.exitCode = 0;
    let out = "";
    let err = "";
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await main(argv);
      return { out, err, code: Number(process.exitCode ?? 0) };
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
      process.exitCode = 0;
      process.env = previous;
    }
  }

  it("writes the audit as a self-contained HTML file next to the Markdown", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "swmcp-")), "audit.html");
    const result = await run(["audit", "--html", file, "--tz", "Europe/Berlin"]);
    expect(result.out).toMatch(/^# Shop audit/);
    const html = readFileSync(file, "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Paid orders not shipped for more than 7 days");
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=/);
  });

  it("prints the brief as Markdown, and as HTML on stdout with --html -", async () => {
    mock.use(
      searchHandler({
        order: "order-aggregations",
        "order-line-item": "line-item-aggregations",
        product: "products-search",
      }),
    );
    const markdown = await run(["brief", "--tz", "UTC"]);
    expect(markdown.out).toMatch(/^# Shop brief · https:\/\/shop\.test/);
    expect(markdown.out).toContain("## Right now");
    expect(markdown.out).toContain("## Last 7 days");
    expect(markdown.code).toBe(0);
    const html = await run(["brief", "--tz", "UTC", "--html", "-"]);
    expect(html.out).toMatch(/^<!doctype html>/);
    expect(html.out).toContain("Right now");
    expect((await run(["brief", "--fail-on", "critical"])).code).toBe(1);
  });

  it("posts a short summary to a Slack webhook and reports a failed delivery", async () => {
    const posted: unknown[] = [];
    mock.use(
      http.post("https://hooks.slack.test/services/x", async ({ request }) => {
        posted.push(await request.json());
        return new HttpResponse("ok");
      }),
      http.post("https://hooks.slack.test/services/broken", () =>
        HttpResponse.text("no_service", { status: 404 }),
      ),
    );
    const ok = await run([
      "audit",
      "--fail-on",
      "none",
      "--slack",
      "https://hooks.slack.test/services/x",
    ]);
    expect(ok.code).toBe(0);
    expect(posted).toHaveLength(1);
    const text = (posted[0] as { text: string }).text;
    expect(text).toMatch(/^:red_circle: \*Shop audit · https:\/\/shop\.test\*/);
    expect(text).toContain("• Paid orders not shipped for more than 7 days (3)");
    const broken = await run([
      "audit",
      "--fail-on",
      "none",
      "--slack",
      "https://hooks.slack.test/services/broken",
    ]);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("Slack: The webhook answered 404");
  });
});
