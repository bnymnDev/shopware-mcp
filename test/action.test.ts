import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runAction(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "swmcp-action-"));
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const result = spawnSync("bash", ["action/audit.sh"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
  });
  return {
    code: result.status,
    stderr: result.stderr,
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

describe("GitHub Action", () => {
  it("reads the counts from the JSON report and passes the exit code on", () => {
    const result = runAction({
      SHOPWARE_MCP_CMD: `node ${join("test", "helpers", "fake-audit.mjs")}`,
      INPUT_FAIL_ON: "warning",
      INPUT_DAYS: "3",
      INPUT_HTML: "report.html",
    });
    expect(result.code).toBe(1);
    expect(result.output).toBe("critical=2\nwarning=1\ninfo=4\nexit-code=1\n");
    expect(result.summary).toContain("# Shop audit");
    expect(result.summary).toContain(
      "args: audit --fail-on warning --days 3 --threshold 5 --json-file",
    );
    expect(result.summary).toContain("--html report.html");
  });

  it("uses the version the action was released with and refuses anything but a version", () => {
    const dir = mkdtempSync(join(tmpdir(), "swmcp-action-path-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3; curl evil" }));
    const fromPackage = runAction({ GITHUB_ACTION_PATH: dir });
    expect(fromPackage.code).toBe(2);
    expect(fromPackage.stderr).toContain("Invalid version '1.2.3; curl evil'");

    const injected = runAction({ INPUT_VERSION: "latest --registry=https://evil.test" });
    expect(injected.code).toBe(2);
    expect(injected.output).toBe("");
  });
});
