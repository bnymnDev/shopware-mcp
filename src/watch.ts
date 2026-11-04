import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pulseHeadline } from "./brief.js";
import type { ShopwareClient } from "./client/index.js";
import { duration } from "./html.js";
import { type Baseline, computePulse, type Pulse } from "./tools/pulse.js";

export type WatchLevel = "ok" | "warning" | "critical";

export interface WatchState {
  level: WatchLevel;
  /** When the level was entered. */
  since: string;
  /** Consecutive ticks in which the shop did not answer. */
  failures: number;
}

export interface WatchOptions {
  timeZone: string;
  baseline: Baseline;
  expectFactor: number;
  /** After this many ticks without an answer the shop itself counts as down. */
  failuresBeforeAlarm?: number;
  /** Synthetic customers to run on every look; a broken one is critical. */
  journeys?: () => Promise<{
    failed: number;
    results: { name: string; ok: boolean; failures: string[] }[];
  }>;
  /** Likely causes, looked up only when an alert goes out. */
  diagnose?: () => Promise<string>;
}

export interface WatchTick {
  state: WatchState;
  /** One line for the terminal or a log. */
  line: string;
  /** Set only when the level changed in a way worth telling a channel about. */
  alert: string | null;
  pulse: Pulse | null;
}

const RANK: Record<WatchLevel, number> = { ok: 0, warning: 1, critical: 2 };
const ICON: Record<WatchLevel, string> = {
  ok: ":large_green_circle:",
  warning: ":large_yellow_circle:",
  critical: ":red_circle:",
};

const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
const signed = (value: number | null) =>
  value === null ? "" : ` (${value > 0 ? "+" : ""}${value} %)`;

/**
 * One look at the shop. Alerts go out when things get worse and when they recover, never on
 * every tick: a channel that hears from the watch only when it matters keeps being read.
 */
export async function watchTick(
  client: ShopwareClient,
  options: WatchOptions,
  previous: WatchState | null,
  now: Date = new Date(),
): Promise<WatchTick> {
  const before = previous ?? { level: "ok", since: now.toISOString(), failures: 0 };
  const stamp = clock(now.toISOString(), options.timeZone);
  let pulse: Pulse;
  try {
    pulse = await computePulse(client, {
      weeks: 8,
      timeZone: options.timeZone,
      baseline: options.baseline,
      expectFactor: options.expectFactor,
      now,
    });
  } catch (error) {
    const failures = before.failures + 1;
    const reason = error instanceof Error ? error.message : String(error);
    const down = failures >= (options.failuresBeforeAlarm ?? 3);
    const level: WatchLevel = down ? "critical" : before.level;
    const alert =
      down && failures === (options.failuresBeforeAlarm ?? 3)
        ? `${ICON.critical} *The shop does not answer* (${failures} checks in a row): ${reason}`
        : null;
    return {
      state: { level, since: level === before.level ? before.since : now.toISOString(), failures },
      line: `${stamp} no answer (${failures}): ${reason}`,
      alert,
      pulse: null,
    };
  }

  const headline = pulseHeadline(pulse);
  let level: WatchLevel = headline.level;
  let alarm = headline.text;
  const journeys = options.journeys ? await options.journeys().catch(() => null) : null;
  const broken = journeys?.results.filter((journey) => !journey.ok) ?? [];
  if (broken.length > 0) {
    level = "critical";
    const lines = broken.map((journey) => `${journey.name}: ${journey.failures.join("; ")}`);
    alarm =
      `${broken.length} of ${journeys?.results.length} customer journeys broke` +
      (headline.level === "ok"
        ? ""
        : `, and ${headline.text.charAt(0).toLowerCase()}${headline.text.slice(1)}`) +
      `\n${lines.map((line) => `• ${line}`).join("\n")}`;
  }
  const last = pulse.lastOrder;
  const summary =
    `${pulse.today.orders} orders today${signed(pulse.change.orders)}` +
    (last ? `, last order ${duration(last.minutesAgo ?? 0)} ago` : "");
  const state: WatchState = {
    level,
    since: level === before.level ? before.since : now.toISOString(),
    failures: 0,
  };
  let alert: string | null = null;
  if (RANK[level] > RANK[before.level]) {
    const diagnosis = options.diagnose ? await options.diagnose().catch(() => null) : null;
    alert =
      `${ICON[level]} *${alarm.split("\n")[0]}*` +
      (alarm.includes("\n") ? `\n${alarm.split("\n").slice(1).join("\n")}` : "") +
      `\n${summary}.` +
      (diagnosis
        ? `\n${diagnosis}`
        : " Check the checkout: checkout_simulate, maintenance mode, payment provider, error log.");
  } else if (level === "ok" && before.level !== "ok") {
    const lasted = Math.round((now.getTime() - Date.parse(before.since)) / 60_000);
    alert =
      `${ICON.ok} *Back to normal* after ${duration(lasted)}` +
      (last ? `: order #${last.orderNumber} at ${clock(last.at, options.timeZone)}` : "") +
      ".";
  }
  const journeyNote = journeys
    ? ` · journeys ${journeys.results.length - broken.length}/${journeys.results.length} ok`
    : "";
  return { state, line: `${stamp} ${level} · ${summary}${journeyNote}`, alert, pulse };
}

/** The state of a cron-driven watch, kept between runs; a missing or broken file starts fresh. */
export function readWatchState(file: string): WatchState | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchState>;
    if (value.level && value.level in RANK && typeof value.since === "string") {
      return { level: value.level, since: value.since, failures: value.failures ?? 0 };
    }
  } catch {
    // A broken state file only costs one possibly repeated alert.
  }
  return null;
}

export function writeWatchState(file: string, state: WatchState): void {
  writeFileSync(file, `${JSON.stringify(state)}\n`);
}
