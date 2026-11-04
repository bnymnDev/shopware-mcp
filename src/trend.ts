import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Brief } from "./brief.js";
import { localDate } from "./tools/zone.js";

/** One day of the shop's health, as the brief saw it. */
export interface HealthDay {
  date: string;
  score: number;
  critical: number;
  warning: number;
  orders: number;
  revenue: number;
}

export interface Trend {
  /** Oldest first, today last. */
  days: HealthDay[];
  today: HealthDay;
  /** Score change against the day a week earlier, when the file reaches back that far. */
  changeOverWeek: number | null;
  /** Findings that are new since the last brief. */
  newFindings: string[];
}

/** Days kept in the history file: a quarter is enough to see a slow decline. */
const KEEP_DAYS = 90;

/**
 * A health score from 0 to 100: each critical finding costs 20, each warning 5, an unusual
 * quiet spell or payment failures 20 (10 when only worth watching). Simple on purpose, so
 * a shop manager can say why the number moved.
 */
export function healthScore(brief: Brief): number {
  const { summary } = brief.audit;
  const pulse = brief.pulse;
  const verdicts = [pulse.silence?.verdict ?? "normal", pulse.payments.verdict];
  const pulsePenalty = verdicts.includes("unusual") ? 20 : verdicts.includes("watch") ? 10 : 0;
  const score = 100 - 20 * summary.critical - 5 * summary.warning - pulsePenalty;
  return Math.max(0, Math.min(100, score));
}

interface HistoryFile {
  days: HealthDay[];
  findings?: string[];
}

function readHistory(file: string): HistoryFile {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<HistoryFile>;
    const days = Array.isArray(value.days)
      ? value.days.filter(
          (day): day is HealthDay =>
            typeof day?.date === "string" && typeof day?.score === "number",
        )
      : [];
    return {
      days,
      findings: Array.isArray(value.findings)
        ? value.findings.filter((id) => typeof id === "string")
        : [],
    };
  } catch {
    // No file yet, or one from somewhere else: start a fresh history.
    return { days: [], findings: [] };
  }
}

/**
 * Add today's score to the history file (replacing an earlier run of the same day) and read
 * the trend back. The file is written atomically, so a crashed run never leaves half a file.
 */
export function recordTrend(file: string, brief: Brief): Trend {
  const history = readHistory(file);
  const today: HealthDay = {
    date: localDate(new Date(brief.generatedAt), brief.timeZone),
    score: healthScore(brief),
    critical: brief.audit.summary.critical,
    warning: brief.audit.summary.warning,
    orders: brief.pulse.today.orders,
    revenue: brief.pulse.today.revenue,
  };
  const days = [...history.days.filter((day) => day.date < today.date), today].slice(-KEEP_DAYS);
  const findings = brief.audit.findings
    .filter((finding) => finding.severity !== "info")
    .map((finding) => finding.id);
  const seen = new Set(history.findings);
  const newFindings = history.days.length === 0 ? [] : findings.filter((id) => !seen.has(id));

  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ days, findings }, null, 2)}\n`);
  renameSync(temp, file);

  const weekAgo = new Date(`${today.date}T12:00:00Z`);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const before = days.find((day) => day.date === weekAgo.toISOString().slice(0, 10));
  return {
    days: days.slice(-30),
    today,
    changeOverWeek: before ? today.score - before.score : null,
    newFindings,
  };
}

const BARS = "▁▂▃▄▅▆▇█";

/** The scores as a one-line sparkline, for a terminal or Slack. */
export function sparkline(scores: number[]): string {
  return scores
    .map((score) => BARS[Math.min(BARS.length - 1, Math.floor((score / 100) * BARS.length))])
    .join("");
}

/** "Health 85/100 (−10 vs a week ago) ▆▇▇█▆" */
export function trendText(trend: Trend): string {
  const change =
    trend.changeOverWeek === null
      ? ""
      : ` (${trend.changeOverWeek > 0 ? "+" : ""}${trend.changeOverWeek} vs a week ago)`;
  const fresh =
    trend.newFindings.length > 0
      ? `; new since the last brief: ${trend.newFindings.join(", ")}`
      : "";
  return `Health ${trend.today.score}/100${change} ${sparkline(trend.days.map((day) => day.score))}${fresh}`;
}
