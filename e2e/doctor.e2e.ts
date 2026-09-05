import { beforeAll, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import type { ToolContext } from "../src/tools/types.js";
import { E2E_ENABLED, e2eContext } from "./setup.js";

describe.skipIf(!E2E_ENABLED)("doctor against a real shop", () => {
  let ctx: ToolContext;
  beforeAll(async () => {
    ctx = await e2eContext(true);
  });

  it("finds every read tool ready for the e2e integration", async () => {
    const report = await runDoctor(ctx);
    expect(report.connection.ok).toBe(true);
    expect(report.shop?.version).toMatch(/^6\./);
    expect(report.ok).toBe(true);
    const blocked = report.tools.filter((item) => item.status === "blocked");
    expect(blocked).toEqual([]);
  });
});
