import { equals } from "./client/criteria.js";
import { defaultFetch, type FetchLike, parseBody } from "./client/fetch.js";
import { USER_AGENT } from "./client/index.js";
import { REQUIREMENTS } from "./doctor.js";
import { fromHttpResponse, ShopwareMcpError } from "./errors.js";
import { extensionPacks } from "./extensions/index.js";
import { tools } from "./tools/index.js";
import { newId, rawList, str, strList } from "./tools/shared.js";

/** Route prefixes behind which Shopware checks a privilege that is not an entity read. */
const ROUTE_PRIVILEGES: [prefix: string, privilege: string][] = [
  ["/api/_action/system-config", "system_config:read"],
];

/**
 * Privileges setup never grants unless asked: `system.plugin_maintain` lets an integration
 * install and update extensions, far more than reading which updates exist.
 */
const OPT_IN = new Set(["system.plugin_maintain"]);

export interface PrivilegeOptions {
  allowWrite: boolean;
  /** Also grant what `plugins_list` needs to show available updates. */
  pluginUpdates?: boolean;
  /** Active plugins of the shop, so plugin-aware tools get their privileges. */
  plugins?: Set<string>;
}

/**
 * Exactly what the registered tools need, from the same table the doctor checks. Every entry
 * there was measured against a role that had nothing else.
 */
export function requiredPrivileges(options: PrivilegeOptions): string[] {
  const granted = new Set<string>();
  const optIn = (privilege: string) => !OPT_IN.has(privilege) || options.pluginUpdates === true;
  for (const tool of tools) {
    if (tool.write && !options.allowWrite) continue;
    const requirement = REQUIREMENTS[tool.name];
    if (!requirement) continue;
    for (const entity of requirement.reads) granted.add(`${entity}:read`);
    for (const privilege of requirement.writes ?? []) granted.add(privilege);
    for (const privilege of requirement.optional ?? [])
      if (optIn(privilege)) granted.add(privilege);
    for (const route of [...(requirement.routes ?? []), ...(requirement.optionalRoutes ?? [])]) {
      for (const [prefix, privilege] of ROUTE_PRIVILEGES) {
        if (route.startsWith(prefix)) granted.add(privilege);
      }
    }
  }
  for (const pack of extensionPacks) {
    for (const entry of pack.tools) {
      if (entry.tool.write && !options.allowWrite) continue;
      if (!entry.requires.every((plugin) => options.plugins?.has(plugin))) continue;
      for (const privilege of entry.privileges ?? []) granted.add(privilege);
    }
  }
  return [...granted].sort();
}

/* ------------------------------------------------------------------------------------------
 * An admin session: the one place this project logs in as a person instead of an integration.
 * ---------------------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

export class AdminSession {
  private constructor(
    readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  /** Password grant with Shopware's own `administration` client, as the admin login does. */
  static async login(
    url: string,
    username: string,
    password: string,
    fetchImpl: FetchLike = defaultFetch,
  ): Promise<AdminSession> {
    const response = await fetchImpl(`${url}/api/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: "administration",
        grant_type: "password",
        username,
        password,
        // Creating roles and integrations needs a freshly verified login, like the admin asks for.
        scope: "user-verified",
      }),
    });
    const body = await parseBody(response);
    const token = str((body as Json | undefined)?.access_token);
    if (!response.ok || !token) {
      if (response.status === 400 || response.status === 401) {
        throw new ShopwareMcpError(
          response.status,
          "LOGIN_FAILED",
          "The shop refused this user name and password",
        );
      }
      throw fromHttpResponse(response.status, body);
    }
    return new AdminSession(url, token, fetchImpl);
  }

  async request<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const body = await parseBody(response);
    if (!response.ok) throw fromHttpResponse(response.status, body);
    return body as T;
  }

  async search(entity: string, criteria: Json): Promise<Json[]> {
    const result = await this.request<Json>(`/api/search/${entity}`, {
      method: "POST",
      body: criteria,
    });
    return rawList(result?.data);
  }
}

/* ------------------------------------------------------------------------------------------
 * Plan and apply
 * ---------------------------------------------------------------------------------------- */

export interface SetupOptions {
  /** Integration label; the role is named after it. */
  name: string;
  allowWrite: boolean;
  pluginUpdates: boolean;
  /** Issue new credentials for an integration of the same name instead of refusing. */
  rotate: boolean;
}

export interface SetupPlan {
  roleName: string;
  privileges: string[];
  plugins: string[];
  role: { id: string; privileges: string[] } | null;
  integration: { id: string; accessKey: string | null; roleIds: string[] } | null;
}

export const roleNameFor = (name: string, allowWrite: boolean) =>
  `${name} (${allowWrite ? "read and write" : "read-only"})`;

export async function planSetup(session: AdminSession, options: SetupOptions): Promise<SetupPlan> {
  const roleName = roleNameFor(options.name, options.allowWrite);
  const [plugins, roles, integrations] = await Promise.all([
    session.search("plugin", {
      limit: 500,
      filter: [equals("active", true)],
      includes: { plugin: ["name"] },
    }),
    session.search("acl-role", {
      limit: 1,
      filter: [equals("name", roleName)],
      includes: { acl_role: ["id", "privileges"] },
    }),
    session.search("integration", {
      limit: 1,
      filter: [equals("label", options.name)],
      associations: { aclRoles: {} },
      includes: { integration: ["id", "accessKey", "aclRoles"], acl_role: ["id"] },
    }),
  ]);
  const active = new Set(plugins.map((plugin) => str(plugin.name)).filter((n): n is string => !!n));
  const role = roles[0];
  const integration = integrations[0];
  return {
    roleName,
    privileges: requiredPrivileges({
      allowWrite: options.allowWrite,
      pluginUpdates: options.pluginUpdates,
      plugins: active,
    }),
    plugins: [...active].sort(),
    role: role ? { id: String(role.id), privileges: strList(role.privileges) } : null,
    integration: integration
      ? {
          id: String(integration.id),
          accessKey: str(integration.accessKey),
          roleIds: rawList(integration.aclRoles).map((entry) => String(entry.id)),
        }
      : null,
  };
}

export interface SetupResult {
  role: { id: string; name: string; created: boolean; privileges: number; added: string[] };
  integration: { id: string; label: string; created: boolean; rotated: boolean };
  credentials: { clientId: string; clientSecret: string };
}

/**
 * Create or update the role, then create the integration (or, with `rotate`, give the
 * existing one new keys). Idempotent for the role: running it after an upgrade adds the
 * privileges new tools need.
 */
export async function applySetup(
  session: AdminSession,
  plan: SetupPlan,
  options: SetupOptions,
): Promise<SetupResult> {
  if (plan.integration && !options.rotate) {
    throw new ShopwareMcpError(
      409,
      "INTEGRATION_EXISTS",
      `An integration named "${options.name}" exists and its secret cannot be read back. ` +
        "Pass --rotate to give it new keys (the old ones stop working) or --name to create another.",
    );
  }
  const roleId = plan.role?.id ?? newId();
  const added = plan.role
    ? plan.privileges.filter((privilege) => !plan.role?.privileges.includes(privilege))
    : plan.privileges;
  if (plan.role) {
    await session.request(`/api/acl-role/${roleId}`, {
      method: "PATCH",
      body: { privileges: plan.privileges },
    });
  } else {
    await session.request("/api/acl-role", {
      method: "POST",
      body: {
        id: roleId,
        name: plan.roleName,
        description:
          "Created by shopware-mcp setup: exactly the privileges its tools need, nothing else.",
        privileges: plan.privileges,
      },
    });
  }

  // Shopware's route really is spelled "intergration".
  const keys = await session.request<{ accessKey: string; secretAccessKey: string }>(
    "/api/_action/access-key/intergration",
  );
  const integrationId = plan.integration?.id ?? newId();
  if (plan.integration) {
    await session.request(`/api/integration/${integrationId}`, {
      method: "PATCH",
      body: {
        accessKey: keys.accessKey,
        secretAccessKey: keys.secretAccessKey,
        admin: false,
        aclRoles: [{ id: roleId }],
      },
    });
    // A role from an earlier setup with the other mode would keep its privileges; drop it.
    const ours = [roleNameFor(options.name, true), roleNameFor(options.name, false)];
    const stale = plan.integration.roleIds.filter((id) => id !== roleId);
    if (stale.length > 0) {
      const named = await session.search("acl-role", {
        limit: stale.length,
        filter: [{ type: "equalsAny", field: "id", value: stale }],
        includes: { acl_role: ["id", "name"] },
      });
      for (const role of named) {
        if (role.id !== roleId && ours.includes(String(role.name))) {
          await session.request(`/api/integration/${integrationId}/acl-roles/${role.id}`, {
            method: "DELETE",
          });
        }
      }
    }
  } else {
    await session.request("/api/integration", {
      method: "POST",
      body: {
        id: integrationId,
        label: options.name,
        accessKey: keys.accessKey,
        secretAccessKey: keys.secretAccessKey,
        admin: false,
        aclRoles: [{ id: roleId }],
      },
    });
  }

  return {
    role: {
      id: roleId,
      name: plan.roleName,
      created: plan.role === null,
      privileges: plan.privileges.length,
      added,
    },
    integration: {
      id: integrationId,
      label: options.name,
      created: plan.integration === null,
      rotated: plan.integration !== null,
    },
    credentials: { clientId: keys.accessKey, clientSecret: keys.secretAccessKey },
  };
}
