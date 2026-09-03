/**
 * Bootstraps an Integration on a dockware instance and exposes a ready ToolContext.
 *
 * Env:
 *   SHOPWARE_E2E=1              required, otherwise the suite is skipped
 *   SHOPWARE_URL                default http://localhost:8000
 *   SHOPWARE_ADMIN_USER/PASS    default admin / shopware (used once to create the integration)
 *   SHOPWARE_CLIENT_ID/SECRET   optional: use an existing integration instead of creating one
 */
import { randomBytes } from "node:crypto";
import { ShopwareClient } from "../src/client/index.js";
import { type Config, MAX_LIMIT } from "../src/config.js";
import type { ToolContext } from "../src/tools/types.js";

export const E2E_ENABLED = process.env.SHOPWARE_E2E === "1";
const SHOP_URL = (process.env.SHOPWARE_URL ?? "http://localhost:8000").replace(/\/+$/, "");

interface Credentials {
  clientId: string;
  clientSecret: string;
}

async function adminToken(): Promise<string> {
  const response = await fetch(`${SHOP_URL}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: "administration",
      scopes: "write",
      username: process.env.SHOPWARE_ADMIN_USER ?? "admin",
      password: process.env.SHOPWARE_ADMIN_PASS ?? "shopware",
    }),
  });
  if (!response.ok) throw new Error(`admin login failed: HTTP ${response.status}`);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

/** Create a throwaway admin Integration via the Admin API (password grant). */
async function createIntegration(): Promise<Credentials> {
  const token = await adminToken();
  const clientId = `SWIA${randomBytes(12).toString("hex").toUpperCase()}`;
  const clientSecret = randomBytes(32).toString("hex");
  const response = await fetch(`${SHOP_URL}/api/integration`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      label: `shopware-mcp e2e ${new Date().toISOString()}`,
      accessKey: clientId,
      secretAccessKey: clientSecret,
      admin: true,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `integration creation failed: HTTP ${response.status} ${await response.text()}`,
    );
  }
  return { clientId, clientSecret };
}

let contextPromise: Promise<ToolContext> | undefined;

export function e2eContext(allowWrite = false): Promise<ToolContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const credentials =
        process.env.SHOPWARE_CLIENT_ID && process.env.SHOPWARE_CLIENT_SECRET
          ? {
              clientId: process.env.SHOPWARE_CLIENT_ID,
              clientSecret: process.env.SHOPWARE_CLIENT_SECRET,
            }
          : await createIntegration();
      const config: Config = {
        url: SHOP_URL,
        ...credentials,
        allowWrite: true,
        extensions: true,
        defaultLimit: 20,
        maxLimit: MAX_LIMIT,
        logLevel: "error",
      };
      return { client: new ShopwareClient(config), config };
    })();
  }
  return contextPromise.then((ctx) => ({ ...ctx, config: { ...ctx.config, allowWrite } }));
}
