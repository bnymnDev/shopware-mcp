import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { readWatchState, watchTick } from "../src/watch.js";
import { createContext, fixture, mock, SHOP_URL } from "./helpers/shopware.js";

const ctx = createContext();
const NOW = new Date("2026-09-27T18:01:38.402Z");
const OPTIONS = { timeZone: "Europe/Berlin", baseline: "recent" as const, expectFactor: 1 };

/** The pulse's two order searches, answered from a real shop; the last order can be moved. */
function orders(lastOrderAt?: string) {
  return http.post(`${SHOP_URL}/api/search/order`, async ({ request }) => {
    const body = (await request.clone().json()) as { sort?: unknown };
    if (!body.sort) return HttpResponse.json(fixture<JsonBodyType>("pulse-aggregations"));
    const last = fixture<{ data: Array<Record<string, unknown>> }>("pulse-last-order");
    if (lastOrderAt && last.data[0]) last.data[0].orderDateTime = lastOrderAt;
    return HttpResponse.json(last as JsonBodyType);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watchTick", () => {
  it("alerts once when orders stop, then stays quiet while nothing changes", async () => {
    mock.use(orders());
    const first = await watchTick(ctx.client, OPTIONS, null, NOW);
    expect(first.state).toMatchObject({ level: "critical", since: NOW.toISOString(), failures: 0 });
    expect(first.alert).toMatch(/^:red_circle: \*No order for 5 h 59 min/);
    expect(first.alert).toContain("checkout_simulate");
    expect(first.line).toBe("20:01 critical · 6 orders today (-35.1 %), last order 5 h 59 min ago");

    const second = await watchTick(ctx.client, OPTIONS, first.state, NOW);
    expect(second.alert).toBeNull();
    expect(second.state.since).toBe(NOW.toISOString());
  });

  it("says when things are back to normal, and for how long they were not", async () => {
    mock.use(orders("2026-09-27T17:55:00.000+00:00"));
    const tick = await watchTick(
      ctx.client,
      OPTIONS,
      { level: "critical", since: "2026-09-27T16:31:38.402Z", failures: 0 },
      NOW,
    );
    expect(tick.state.level).toBe("ok");
    expect(tick.alert).toBe(
      ":large_green_circle: *Back to normal* after 1 h 30 min: order #10759 at 19:55.",
    );
  });

  it("counts a shop that does not answer three times in a row as down, and alerts once", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/order`, () =>
        HttpResponse.json(
          { errors: [{ status: "503", code: "DOWN", detail: "down" }] },
          { status: 503 },
        ),
      ),
    );
    const options = { ...OPTIONS };
    let state = null;
    const alerts: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const tick = await watchTick(ctx.client, options, state, NOW);
      state = tick.state;
      alerts.push(tick.alert);
    }
    expect(alerts.slice(0, 2)).toEqual([null, null]);
    expect(alerts[2]).toMatch(/^:red_circle: \*The shop does not answer\* \(3 checks in a row\)/);
    expect(alerts[3]).toBeNull();
    expect(state).toMatchObject({ level: "critical", failures: 4 });
  }, 20_000);
});

describe("watch --once", () => {
  it("remembers the state between cron runs and posts to Slack only on a change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const posts: string[] = [];
    mock.use(
      orders(),
      http.post("https://hooks.slack.test/watch", async ({ request }) => {
        posts.push(((await request.json()) as { text: string }).text);
        return new HttpResponse("ok");
      }),
    );
    const file = join(mkdtempSync(join(tmpdir(), "swmcp-watch-")), "state.json");
    const env = {
      SHOPWARE_URL: SHOP_URL,
      SHOPWARE_CLIENT_ID: "SWIATEST",
      SHOPWARE_CLIENT_SECRET: "secret",
    };
    const run = async () => {
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
        await main([
          "watch",
          "--once",
          "--state",
          file,
          "--tz",
          "Europe/Berlin",
          "--slack",
          "https://hooks.slack.test/watch",
        ]);
        return { out, code: Number(process.exitCode ?? 0) };
      } finally {
        process.stdout.write = write;
        process.exitCode = 0;
        process.env = previous;
      }
    };
    const first = await run();
    expect(first.code).toBe(1);
    expect(first.out).toContain("critical · 6 orders today");
    expect(readWatchState(file)).toMatchObject({ level: "critical" });
    const second = await run();
    expect(second.code).toBe(1);
    expect(posts).toHaveLength(1);

    writeFileSync(file, "{ broken");
    expect(readWatchState(file)).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("{ broken");
  });
});
