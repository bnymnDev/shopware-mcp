import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";

describe("parseCli", () => {
  it("has safe defaults", () => {
    expect(parseCli([])).toEqual({
      allowWrite: undefined,
      http: false,
      port: 3333,
      host: "127.0.0.1",
      logLevel: undefined,
      help: false,
      version: false,
    });
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
  });
});
