import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";

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
