import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { REQUIREMENTS } from "../src/doctor.js";
import {
  AdminSession,
  applySetup,
  planSetup,
  requiredPrivileges,
  roleNameFor,
  type SetupOptions,
  toolsLeftOut,
} from "../src/setup.js";
import { tools } from "../src/tools/index.js";
import { mock, SHOP_URL } from "./helpers/shopware.js";

const OPTIONS: SetupOptions = {
  name: "shopware-mcp",
  allowWrite: false,
  pluginUpdates: false,
  rotate: false,
};

describe("requiredPrivileges", () => {
  it("covers every tool from the measured requirements table", () => {
    const missing = tools.filter((tool) => !REQUIREMENTS[tool.name]).map((tool) => tool.name);
    expect(missing).toEqual([]);
  });

  it("grants reads and the association reads Shopware checks, but no writes by default", () => {
    const privileges = requiredPrivileges({ allowWrite: false });
    expect(privileges).toEqual([...privileges].sort());
    expect(privileges).toEqual(
      expect.arrayContaining([
        "product:read",
        "order:read",
        "order_customer:read",
        "state_machine_state:read",
        "product_search_keyword:read",
        "api_proxy_switch-customer",
        "promotion_individual_code:read",
        "promotion_sales_channel:read",
      ]),
    );
    expect(privileges.some((privilege) => /:(create|update|delete)$/.test(privilege))).toBe(false);
    expect(privileges).not.toContain("system.plugin_maintain");
    expect(privileges).not.toContain("system_config:read");
    expect(privileges.some((privilege) => privilege.startsWith("frosh_"))).toBe(false);
  });

  it("adds exactly the write privileges with allowWrite", () => {
    const reads = new Set(requiredPrivileges({ allowWrite: false }));
    const all = requiredPrivileges({ allowWrite: true });
    const added = all.filter((privilege) => !reads.has(privilege));
    expect(added).toEqual(
      expect.arrayContaining([
        "product:update",
        "product:create",
        "document:create",
        "tag:create",
        "customer_tag:create",
        "customer_tag:delete",
        "media:create",
      ]),
    );
    expect(
      all.some((privilege) => privilege.endsWith(":delete") && !privilege.includes("_tag")),
    ).toBe(false);
  });

  it("grants plugin maintenance and the whole system config only on request", () => {
    expect(requiredPrivileges({ allowWrite: false, pluginUpdates: true })).toContain(
      "system.plugin_maintain",
    );
    expect(requiredPrivileges({ allowWrite: false, settings: true })).toContain(
      "system_config:read",
    );
    expect(toolsLeftOut({ allowWrite: false })).toEqual([
      { tool: "shop_settings", flag: "--settings" },
    ]);
    expect(toolsLeftOut({ allowWrite: false, settings: true })).toEqual([]);
  });

  it("grants the Merqo pack's reads only for the Merqo plugins that are installed", () => {
    const privileges = requiredPrivileges({
      allowWrite: false,
      plugins: new Set(["MerqoReturns", "MerqoVault"]),
    });
    expect(privileges).toEqual(
      expect.arrayContaining([
        "merqo_return:read",
        "merqo_return_line_item:read",
        "merqo_vault_document:read",
      ]),
    );
    expect(privileges).not.toContain("merqo_cart_snapshot:read");
  });

  it("grants plugin privileges only when the plugin is installed", () => {
    const withFrosh = requiredPrivileges({ allowWrite: false, plugins: new Set(["FroshTools"]) });
    expect(withFrosh).toEqual(
      expect.arrayContaining([
        "frosh_tools:read",
        "frosh_tools_queue:read",
        "frosh_tools_security:read",
      ]),
    );
  });
});

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

const OURS = "Created by shopware-mcp setup: exactly the privileges its tools need, nothing else.";

function adminShop(state: {
  role?: { id: string; privileges: string[]; description?: string };
  integration?: { id: string; admin?: boolean; roles: { id: string; name: string }[] };
  plugins?: string[];
}) {
  const writes: Recorded[] = [];
  const record = async (request: Request) => {
    const text = await request.clone().text();
    writes.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : undefined,
    });
  };
  const handlers = [
    http.post(`${SHOP_URL}/api/oauth/token`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.password !== "right") {
        return HttpResponse.json(
          { errors: [{ code: "6", title: "The user credentials were incorrect." }] },
          { status: 400 },
        );
      }
      expect(body).toMatchObject({
        client_id: "administration",
        grant_type: "password",
        scope: "user-verified",
        username: "admin",
      });
      return HttpResponse.json({ access_token: "admin-token", expires_in: 600 });
    }),
    http.post(`${SHOP_URL}/api/search/plugin`, () =>
      HttpResponse.json({ data: (state.plugins ?? []).map((name) => ({ name })) }),
    ),
    http.post(`${SHOP_URL}/api/search/acl-role`, async ({ request }) => {
      const body = JSON.stringify(await request.json());
      if (body.includes('"equalsAny"')) {
        return HttpResponse.json({ data: state.integration?.roles ?? [] });
      }
      return HttpResponse.json({ data: state.role ? [state.role] : [] });
    }),
    http.post(`${SHOP_URL}/api/search/integration`, () =>
      HttpResponse.json({
        data: state.integration
          ? [
              {
                id: state.integration.id,
                accessKey: "SWIAOLD",
                admin: state.integration.admin ?? false,
                aclRoles: state.integration.roles,
              },
            ]
          : [],
      }),
    ),
    http.get(`${SHOP_URL}/api/_action/access-key/intergration`, ({ request }) => {
      expect(request.headers.get("authorization")).toBe("Bearer admin-token");
      return HttpResponse.json({ accessKey: "SWIANEWKEY", secretAccessKey: "new-secret" });
    }),
    http.post(`${SHOP_URL}/api/acl-role`, async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 204 });
    }),
    http.patch(`${SHOP_URL}/api/acl-role/:id`, async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${SHOP_URL}/api/integration`, async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 204 });
    }),
    http.patch(`${SHOP_URL}/api/integration/:id`, async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${SHOP_URL}/api/integration/:id/acl-roles/:roleId`, async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
  return { writes, handlers };
}

describe("setup against a shop", () => {
  it("refuses a wrong password with a plain message", async () => {
    const shop = adminShop({});
    mock.use(...shop.handlers);
    await expect(AdminSession.login(SHOP_URL, "admin", "wrong")).rejects.toMatchObject({
      code: "LOGIN_FAILED",
    });
  });

  it("creates a role with the measured privileges and an integration that is not an admin", async () => {
    const shop = adminShop({ plugins: ["FroshTools"] });
    mock.use(...shop.handlers);
    const session = await AdminSession.login(SHOP_URL, "admin", "right");
    const plan = await planSetup(session, OPTIONS);
    expect(plan).toMatchObject({
      roleName: "shopware-mcp (read-only)",
      role: null,
      integration: null,
      plugins: ["FroshTools"],
    });
    expect(plan.privileges).toContain("frosh_tools:read");

    const result = await applySetup(session, plan, OPTIONS);
    const [role, integration] = shop.writes;
    expect(role).toMatchObject({
      method: "POST",
      path: "/api/acl-role",
      body: { name: "shopware-mcp (read-only)", description: OURS, privileges: plan.privileges },
    });
    const roleId = (role?.body as { id: string } | undefined)?.id;
    expect(integration).toMatchObject({
      method: "POST",
      path: "/api/integration",
      body: {
        label: "shopware-mcp",
        accessKey: "SWIANEWKEY",
        secretAccessKey: "new-secret",
        aclRoles: [{ id: roleId }],
      },
    });
    // Only administrators may send the admin flag at all; a new integration is not one anyway.
    expect(integration?.body).not.toHaveProperty("admin");
    expect(result).toMatchObject({
      role: { id: roleId, created: true, privileges: plan.privileges.length },
      integration: { created: true, rotated: false },
      credentials: { clientId: "SWIANEWKEY", clientSecret: "new-secret" },
    });
  });

  it("refuses to touch an existing integration without --rotate", async () => {
    const shop = adminShop({ integration: { id: "i1", roles: [] } });
    mock.use(...shop.handlers);
    const session = await AdminSession.login(SHOP_URL, "admin", "right");
    const plan = await planSetup(session, OPTIONS);
    await expect(applySetup(session, plan, OPTIONS)).rejects.toMatchObject({
      code: "INTEGRATION_EXISTS",
      status: 409,
    });
    expect(shop.writes).toEqual([]);
  });

  it("updates the role, rotates the keys and drops its own stale role, not a foreign one", async () => {
    const shop = adminShop({
      role: { id: "rw", privileges: ["product:read", "user:update"], description: OURS },
      integration: {
        id: "i1",
        admin: true,
        roles: [
          { id: "ro", name: roleNameFor("shopware-mcp", false) },
          { id: "other", name: "Support team" },
          { id: "rw", name: roleNameFor("shopware-mcp", true) },
        ],
      },
    });
    mock.use(...shop.handlers);
    const options = { ...OPTIONS, allowWrite: true, rotate: true };
    const session = await AdminSession.login(SHOP_URL, "admin", "right");
    const plan = await planSetup(session, options);
    const result = await applySetup(session, plan, options);
    // The stale role goes before the keys change, so a failure leaves the old keys working.
    expect(shop.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      "PATCH /api/acl-role/rw",
      "DELETE /api/integration/i1/acl-roles/ro",
      "PATCH /api/integration/i1",
    ]);
    expect(shop.writes[2]?.body).toEqual({
      accessKey: "SWIANEWKEY",
      secretAccessKey: "new-secret",
      admin: false,
      aclRoles: [{ id: "rw" }],
    });
    expect(result.role).toMatchObject({ created: false, name: "shopware-mcp (read and write)" });
    expect(result.role.added).toContain("product:update");
    expect(result.role.added).not.toContain("product:read");
    expect(result.role.removed).toEqual(["user:update"]);
    expect(result.integration).toMatchObject({ created: false, rotated: true });
  });

  it("brings the role of its own integration up to date without touching the keys", async () => {
    const shop = adminShop({
      role: { id: "ro", privileges: ["product:read", "user:update"], description: OURS },
      integration: { id: "i1", roles: [{ id: "ro", name: roleNameFor("shopware-mcp", false) }] },
    });
    mock.use(...shop.handlers);
    const session = await AdminSession.login(SHOP_URL, "admin", "right");
    const result = await applySetup(session, await planSetup(session, OPTIONS), OPTIONS);
    expect(shop.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      "PATCH /api/acl-role/ro",
    ]);
    expect(result).toMatchObject({
      credentials: null,
      integration: { created: false, rotated: false },
      role: { removed: ["user:update"] },
    });
  });

  it("does not take over a role of the same name that setup did not create", async () => {
    const shop = adminShop({
      role: { id: "theirs", privileges: ["order:read"], description: "Support team" },
    });
    mock.use(...shop.handlers);
    const session = await AdminSession.login(SHOP_URL, "admin", "right");
    const plan = await planSetup(session, OPTIONS);
    await expect(applySetup(session, plan, OPTIONS)).rejects.toMatchObject({
      code: "ROLE_EXISTS",
      status: 409,
    });
    expect(shop.writes).toEqual([]);
  });
});
