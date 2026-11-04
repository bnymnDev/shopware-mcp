import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { isMajor, updateCheck } from "../src/tools/updates.js";
import { createContext, mock, SHOP_URL, searchHandler } from "./helpers/shopware.js";

const ctx = createContext();
const denied = (code: string, detail: string, status = 403) =>
  HttpResponse.json({ errors: [{ status: String(status), code, detail }] }, { status });

describe("update_check", () => {
  it("tells a major update apart from a patch", () => {
    expect(isMajor("6.7.2.2", "6.7.16.0")).toBe(false);
    expect(isMajor("6.7.16.0", "6.8.0.0")).toBe(true);
  });

  it("sorts the extensions by what to do before a major update", async () => {
    mock.use(
      http.get(`${SHOP_URL}/api/_info/version`, () => HttpResponse.json({ version: "6.7.16.0" })),
      http.get(`${SHOP_URL}/api/_action/update/check`, () =>
        HttpResponse.json({
          version: "6.8.0.0",
          title: "Release v6.8.0.0",
          date: "2027-01-20T10:00:00.000+00:00",
          fixedVulnerabilities: [
            { severity: "high", summary: "XSS in the cart", link: "https://x" },
          ],
        }),
      ),
      http.get(`${SHOP_URL}/api/_action/update/check-requirements`, () =>
        HttpResponse.json([
          { name: "writeableCheck", result: false, message: "writeableCheckInvalid" },
          { name: "validShopwareLicense", result: true, message: "validShopwareLicense" },
        ]),
      ),
      http.get(`${SHOP_URL}/api/_action/update/extension-compatibility`, () =>
        HttpResponse.json([
          {
            name: "SwagPayPal",
            installedVersion: "9.1.0",
            statusName: "updatableNow",
            statusMessage: "",
          },
          {
            name: "OldSlider",
            installedVersion: "1.0.0",
            statusName: "notCompatible",
            statusMessage: "",
          },
          {
            name: "MyShopTheme",
            installedVersion: "2.0.0",
            statusName: "notInStore",
            statusMessage: "",
          },
          {
            name: "SwagCms",
            installedVersion: "3.0.0",
            statusName: "compatible",
            statusMessage: "",
          },
        ]),
      ),
    );
    const result = await updateCheck(ctx.client);
    expect(result.update).toMatchObject({ version: "6.8.0.0", major: true });
    expect(result.summary).toEqual({
      blockers: 2,
      updateFirst: 1,
      wait: 0,
      checkYourself: 1,
      compatible: 1,
    });
    expect(result.blockers).toEqual([
      "OldSlider: not compatible and no compatible version in the store",
      "writeableCheck: writeableCheckInvalid",
    ]);
    expect(result.notes.join(" ")).toContain("feature flag");
    expect(result.notes.join(" ")).toContain("fixes 1 security issue");
  });

  it("falls back to the installed extensions when Shopware wants an admin user", async () => {
    mock.use(
      searchHandler({
        plugin: () => ({
          total: 1,
          data: [
            {
              name: "SwagPayPal",
              version: "9.1.0",
              active: true,
              installedAt: "2026-01-01T00:00:00.000+00:00",
            },
          ],
        }),
      }),
    );
    mock.use(
      http.get(`${SHOP_URL}/api/_info/version`, () => HttpResponse.json({ version: "6.7.2.2" })),
      http.get(`${SHOP_URL}/api/_action/update/check`, () => HttpResponse.json({})),
      http.get(`${SHOP_URL}/api/_action/update/check-requirements`, () =>
        denied("FRAMEWORK__MISSING_PRIVILEGE_ERROR", "system:core:update"),
      ),
      http.get(`${SHOP_URL}/api/_action/update/extension-compatibility`, () =>
        denied(
          "FRAMEWORK__INVALID_CONTEXT_SOURCE_USER",
          "AdminApiSource does not have a valid user ID",
          400,
        ),
      ),
      http.get(`${SHOP_URL}/api/_action/extension/installed`, () => HttpResponse.json([])),
    );
    const result = await updateCheck(ctx.client);
    expect(result.upToDate).toBe(true);
    expect(result.requirements).toBeNull();
    expect(result.extensions).toEqual([
      expect.objectContaining({ name: "SwagPayPal", verdict: "check yourself" }),
    ]);
    expect(result.notes.join(" ")).toContain("only for a logged-in admin user");
  });
});
