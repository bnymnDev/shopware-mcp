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
      failOn: "critical",
      from: undefined,
      to: undefined,
      interval: "day",
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
    expect(JSON.parse(json.out).summary.checksRun).toBe(16);
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
