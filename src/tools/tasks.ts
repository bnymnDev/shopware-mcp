import { z } from "zod";
import type { Raw, ShopwareClient } from "../client/index.js";
import { DAY_MS } from "./periods.js";
import { num, str } from "./shared.js";
import { defineTool } from "./types.js";

/** Statuses in which a task is waiting for the scheduler; anything past due there is stuck. */
const WAITING = new Set(["scheduled", "queued"]);

function mapTask(task: Raw, now: Date, graceMinutes: number) {
  const status = str(task.status);
  const next = str(task.nextExecutionTime);
  const overdueMinutes =
    next && status && WAITING.has(status)
      ? Math.max(0, Math.floor((now.getTime() - Date.parse(next)) / 60_000))
      : 0;
  return {
    id: str(task.id),
    name: str(task.name),
    class: str(task.scheduledTaskClass),
    status,
    runIntervalSeconds: num(task.runInterval),
    lastExecutionTime: str(task.lastExecutionTime),
    nextExecutionTime: next,
    overdueMinutes,
    problem:
      status === "failed"
        ? "failed"
        : overdueMinutes > graceMinutes
          ? "overdue"
          : status === "running" &&
              str(task.lastExecutionTime) &&
              now.getTime() - Date.parse(str(task.lastExecutionTime) ?? "") > DAY_MS
            ? "running for over a day"
            : null,
  };
}

export async function listScheduledTasks(
  client: ShopwareClient,
  graceMinutes: number,
  now = new Date(),
) {
  const result = await client.search<Raw>("scheduled-task", {
    page: 1,
    limit: 100,
    "total-count-mode": 1,
    sort: [{ field: "nextExecutionTime", order: "ASC" }],
  });
  const tasks = result.items.map((task) => mapTask(task, now, graceMinutes));
  const byStatus: Record<string, number> = {};
  for (const task of tasks) {
    const key = task.status ?? "unknown";
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  const problems = tasks.filter((task) => task.problem);
  return {
    total: result.total,
    summary: {
      byStatus,
      overdue: tasks.filter((task) => task.problem === "overdue").length,
      failed: tasks.filter((task) => task.problem === "failed").length,
      stuck: tasks.filter((task) => task.problem === "running for over a day").length,
      longestOverdueMinutes: Math.max(0, ...tasks.map((task) => task.overdueMinutes)),
      lastRun:
        tasks
          .map((task) => task.lastExecutionTime)
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1) ?? null,
    },
    tasks,
    problems,
    /** True when the shop has more tasks than the first hundred read here. */
    truncated: tasks.length < result.total,
  };
}

export const scheduledTasksList = defineTool({
  name: "scheduled_tasks_list",
  title: "Scheduled tasks",
  description:
    "Shopware's scheduled tasks (indexing, cleanups, cache invalidation, plugin jobs) with " +
    "status, interval, last and next run, and per task whether it is overdue past a grace " +
    "period, failed, or stuck running for over a day. " +
    "Many overdue tasks with no recent last run mean the scheduler or message worker is not " +
    "running, which shows up as stale search results, missing thumbnails and unsent mails. " +
    "Read-only. Returns { total, summary: { byStatus, overdue, failed, stuck, " +
    "longestOverdueMinutes, lastRun }, tasks[], problems[], truncated }.",
  inputSchema: {
    graceMinutes: z
      .number()
      .int()
      .min(1)
      .max(10_080)
      .default(15)
      .describe("A waiting task past its next run by more than this counts as overdue"),
    onlyProblems: z.boolean().default(false).describe("Return only overdue, failed or stuck tasks"),
  },
  handler: async (input, ctx) => {
    const result = await listScheduledTasks(ctx.client, input.graceMinutes);
    return input.onlyProblems ? { ...result, tasks: result.problems } : result;
  },
});
