import type { Raw, ShopwareClient } from "../client/index.js";
import { ShopwareMcpError } from "../errors.js";
import { listExtensions } from "./plugins.js";
import { rawList, str } from "./shared.js";
import { defineTool } from "./types.js";

/** What Shopware's update service says about one extension and the next Shopware version. */
const STATUS = {
  notCompatible: {
    verdict: "blocker",
    text: "not compatible and no compatible version in the store",
  },
  updatableNow: {
    verdict: "update first",
    text: "a compatible version is available now: update the extension before Shopware",
  },
  updatableFuture: {
    verdict: "wait",
    text: "the vendor has announced a compatible version that is not out yet",
  },
  notInStore: {
    verdict: "check yourself",
    text: "not in the Shopware Store (own or composer-managed code): test it on a staging copy",
  },
  compatible: { verdict: "ok", text: "compatible" },
} as const;

type StatusName = keyof typeof STATUS;

export const isMajor = (from: string, to: string) => {
  const major = (version: string) => version.split(".").slice(0, 2).join(".");
  return major(from) !== major(to);
};

/** A route the role may not call is a gap in the answer, not a failure of the whole check. */
async function attempt<T>(run: () => Promise<T>): Promise<{ value: T } | { refused: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    if (error instanceof ShopwareMcpError && error.status === 403) {
      return { refused: error.detail ?? "access denied" };
    }
    if (error instanceof ShopwareMcpError) return { refused: `${error.code}: ${error.detail}` };
    throw error;
  }
}

export async function updateCheck(client: ShopwareClient) {
  const version = str((await client.request<Raw>("/api/_info/version")).version) ?? "unknown";
  const [update, requirements, extensions] = await Promise.all([
    attempt(() => client.request<Raw | null>("/api/_action/update/check")),
    attempt(() => client.request<Raw[]>("/api/_action/update/check-requirements")),
    attempt(() => client.request<Raw[]>("/api/_action/update/extension-compatibility")),
  ]);

  const notes: string[] = [];
  const next =
    "value" in update && update.value && str(update.value.version)
      ? {
          version: str(update.value.version) ?? "",
          date: str(update.value.date),
          title: str(update.value.title),
          major: isMajor(version, str(update.value.version) ?? version),
          fixedVulnerabilities: rawList(update.value.fixedVulnerabilities).map((entry) => ({
            severity: str(entry.severity),
            summary: str(entry.summary),
            link: str(entry.link),
          })),
        }
      : null;
  if ("refused" in update) notes.push(`Available update not checked: ${update.refused}`);

  const checks =
    "value" in requirements
      ? (Array.isArray(requirements.value) ? requirements.value : []).map((check) => ({
          name: str(check.name),
          ok: check.result === true,
          message: str(check.message),
        }))
      : null;
  if ("refused" in requirements) notes.push(`Requirements not checked: ${requirements.refused}`);

  let compat =
    "value" in extensions
      ? (Array.isArray(extensions.value) ? extensions.value : []).map((entry) => {
          const name = (str(entry.statusName) ?? "notInStore") as StatusName;
          const status = STATUS[name] ?? STATUS.notInStore;
          return {
            name: str(entry.name),
            installedVersion: str(entry.installedVersion),
            managedByComposer: entry.managedByComposer === true,
            status: name,
            verdict: status.verdict,
            explanation: str(entry.statusMessage) || status.text,
          };
        })
      : null;
  if ("refused" in extensions) {
    // Shopware asks its store about compatibility in an admin user's name only, so an
    // integration is always refused; the installed list is the next best answer.
    const userOnly = /INVALID_CONTEXT_SOURCE_USER|valid user ID/.test(extensions.refused);
    const installed = await listExtensions(client).catch(() => null);
    if (installed) {
      compat = installed.items
        .filter((extension) => extension.active)
        .map((extension) => ({
          name: extension.name,
          installedVersion: extension.version,
          managedByComposer: extension.managedByComposer === true,
          status: "unknown" as StatusName,
          verdict: "check yourself" as const,
          explanation: extension.upgradeVersion
            ? `update to ${extension.upgradeVersion} available; check its compatibility in the Shopware Store`
            : "compatibility unknown: check it in the Shopware Store or on a staging copy",
        }));
    }
    notes.push(
      userOnly
        ? "Shopware answers the extension compatibility check only for a logged-in admin " +
            "user, not for an integration: open Settings → System → Shopware Update in the " +
            "admin for the store's verdict. Listed here are the active extensions to check."
        : `Extensions not checked: ${extensions.refused}`,
    );
  }

  const count = (verdict: string) => compat?.filter((entry) => entry.verdict === verdict).length;
  const blockers = [
    ...(compat ?? [])
      .filter((entry) => entry.verdict === "blocker")
      .map((entry) => `${entry.name}: ${entry.explanation}`),
    ...(checks ?? [])
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.message}`),
  ];
  const security = next?.fixedVulnerabilities.length ?? 0;
  if (next?.major) {
    notes.push(
      `${next.version} is a major version: try it on a staging copy first. Shopware ships the ` +
        "next major's breaking changes behind the feature flag of that version (e.g. " +
        "v6.8.0.0), so a staging shop can switch them on before the update.",
    );
  }
  if (security > 0) {
    notes.push(
      `The update fixes ${security} security issue${security === 1 ? "" : "s"}: plan it soon, ` +
        "or install the security plugin that covers them.",
    );
  }

  return {
    currentVersion: version,
    update: next,
    upToDate: "value" in update ? next === null : null,
    requirements: checks,
    extensions: compat,
    summary: {
      blockers: blockers.length,
      updateFirst: count("update first") ?? null,
      wait: count("wait") ?? null,
      checkYourself: count("check yourself") ?? null,
      compatible: count("ok") ?? null,
    },
    blockers,
    notes,
  };
}

export const updateCheckTool = defineTool({
  name: "update_check",
  title: "Ready for the next Shopware update?",
  description:
    "Before a Shopware update, a major one like 6.8 included: the version available next and " +
    "the security issues it fixes, Shopware's own requirement checks, and for every " +
    "extension whether it works with that version (compatible, update the extension first, " +
    "a compatible version announced, not compatible, or not in the store so test it " +
    "yourself), straight from Shopware's update service. Read-only: it never starts an " +
    "update. Needs the privilege system:core:update (and system_config:read for the " +
    "extensions), which setup grants with --plugin-updates. Returns { currentVersion, update, " +
    "upToDate, requirements[], extensions[], summary, blockers[], notes[] }.",
  inputSchema: {},
  handler: (_input, ctx) => updateCheck(ctx.client),
});
