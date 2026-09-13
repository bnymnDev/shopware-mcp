import { z } from "zod";
import type { Raw } from "../client/index.js";
import { bool, num, rawList, str } from "../tools/shared.js";
import { defineTool } from "../tools/types.js";
import type { ExtensionPack } from "./types.js";

/* --------------------------------------------------------------------------------------------
 * FroshTools (https://github.com/FriendsOfShopware/FroshTools) — the open-source operations
 * toolbox many Shopware hosters install. Its Admin API routes answer "is the platform healthy?"
 * at a level the core API does not reach: PHP and MySQL settings, queue backlog, overdue
 * scheduled tasks, dependency advisories. Read-only routes only; nothing here clears a cache,
 * purges a queue or runs a task.
 * ------------------------------------------------------------------------------------------ */

const BASE = "/api/_action/frosh-tools";
const STATES = ["ok", "info", "warning", "error"] as const;
type State = (typeof STATES)[number];

const STATE_NAMES: Record<string, State> = {
  STATE_OK: "ok",
  STATE_INFO: "info",
  STATE_WARNING: "warning",
  STATE_ERROR: "error",
};

function mapCheck(check: Raw, category: "health" | "performance") {
  const raw = str(check.state) ?? "";
  return {
    id: str(check.id),
    category,
    label: str(check.snippet),
    state: STATE_NAMES[raw] ?? (raw.toLowerCase() as State),
    current: str(check.current),
    recommended: str(check.recommended) || null,
  };
}

export const froshHealth = defineTool({
  name: "frosh_health",
  title: "FroshTools health and performance checks",
  description:
    "Read FroshTools' server health checks (PHP memory and settings, MySQL configuration, open " +
    "queue age, overdue scheduled tasks, Composer security advisories, file permissions) and " +
    "its performance recommendations (worker, caches, logging levels). Each check has a state " +
    "of ok, info, warning or error with the current and the recommended value. Use it when the " +
    "question is about the platform rather than the shop's data. Read-only. Returns one object.",
  inputSchema: {
    state: z
      .array(z.enum(STATES))
      .optional()
      .describe("Only checks in these states, e.g. ['warning', 'error']"),
    includePerformance: z.boolean().default(true),
  },
  handler: async (input, ctx) => {
    const [health, performance] = await Promise.all([
      ctx.client.request<unknown>(`${BASE}/health/status`),
      input.includePerformance
        ? ctx.client.request<unknown>(`${BASE}/performance/status`)
        : Promise.resolve([]),
    ]);
    const checks = [
      ...rawList(health).map((check) => mapCheck(check, "health")),
      ...rawList(performance).map((check) => mapCheck(check, "performance")),
    ];
    const selected = input.state ? checks.filter((c) => input.state?.includes(c.state)) : checks;
    return {
      summary: {
        ok: checks.filter((c) => c.state === "ok").length,
        info: checks.filter((c) => c.state === "info").length,
        warning: checks.filter((c) => c.state === "warning").length,
        error: checks.filter((c) => c.state === "error").length,
      },
      checks: selected,
    };
  },
});

export const froshQueue = defineTool({
  name: "frosh_queue",
  title: "FroshTools message queue status",
  description:
    "Read the state of Shopware's message queue through FroshTools: every transport with its " +
    "size, the age of its oldest message and when a worker was last seen, plus the waiting " +
    "messages per message class. A growing async queue or a worker last seen hours ago " +
    "explains stale search indexes, missing thumbnails and unsent mails. Read-only. " +
    "Returns { transports[], messages[] }.",
  inputSchema: {},
  handler: async (_input, ctx) => {
    const [transports, messages] = await Promise.all([
      ctx.client.request<unknown>(`${BASE}/queue/transports`),
      ctx.client.request<unknown>(`${BASE}/queue/list`),
    ]);
    return {
      transports: rawList(transports).map((transport) => ({
        name: str(transport.name),
        type: str(transport.type),
        size: num(transport.size),
        oldestMessageAgeSeconds: num(transport.oldestMessageAgeSeconds),
        workerLastSeenSeconds: num(transport.workerLastSeenSeconds),
        browsable: bool(transport.browsable),
      })),
      messages: rawList(messages).map((message) => ({
        name: str(message.name),
        size: num(message.size),
      })),
    };
  },
});

export const froshComposerAudit = defineTool({
  name: "frosh_composer_audit",
  title: "FroshTools dependency advisories",
  description:
    "Known security advisories for the shop's PHP dependencies, as FroshTools reads them from " +
    "Composer (cached by the plugin). Use it for 'does the shop run vulnerable packages?'. " +
    "Read-only. Returns { packages, vulnerable, advisories[], cachedAt }.",
  inputSchema: {},
  handler: async (_input, ctx) => {
    const audit = await ctx.client.request<Raw>(`${BASE}/composer-audit`);
    const cachedAt = num(audit.cachedAt);
    return {
      packages: num(audit.packages),
      vulnerable: num(audit.vulnerable),
      advisories: rawList(audit.advisories).map((advisory) => ({
        package: str(advisory.packageName) ?? str(advisory.package),
        title: str(advisory.title),
        cve: str(advisory.cve),
        severity: str(advisory.severity),
        affectedVersions: str(advisory.affectedVersions),
        link: str(advisory.link),
      })),
      cachedAt: cachedAt ? new Date(cachedAt * 1000).toISOString() : null,
    };
  },
});

export const froshPack: ExtensionPack = {
  id: "frosh",
  label: "FroshTools",
  url: "https://github.com/FriendsOfShopware/FroshTools",
  tools: [
    { requires: ["FroshTools"], tool: froshHealth },
    { requires: ["FroshTools"], tool: froshQueue },
    { requires: ["FroshTools"], tool: froshComposerAudit },
  ],
};
