import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { formatDoctorReport, runDoctor } from "../src/doctor.js";
import { tools } from "../src/tools/index.js";
import { createContext, mock, requests, SHOP_URL, searchHandler } from "./helpers/shopware.js";

const empty = () => ({ total: 0, data: [] });
const PROBED = [
  "sales-channel",
  "product",
  "order",
  "document",
  "customer",
  "category",
  "promotion",
  "plugin",
  "order-line-item",
  "order-delivery",
  "order-transaction",
  "currency",
  "language",
];
const allEmpty = Object.fromEntries(PROBED.map((entity) => [entity, empty]));
const forbidden = () =>
  HttpResponse.json(
    { errors: [{ code: "FRAMEWORK__MISSING_PRIVILEGE", detail: "missing" }] },
    { status: 403 },
  );

describe("doctor", () => {
  it("reports an administrator integration as ready everywhere without probing", async () => {
    mock.use(
      searchHandler({
        integration: () => ({
          total: 1,
          data: [{ id: "i1", label: "mcp", admin: true, aclRoles: [] }],
        }),
      }),
    );
    const report = await runDoctor(createContext({ allowWrite: true }));
    expect(report.ok).toBe(true);
    expect(report.connection).toEqual({ ok: true, detail: null });
    expect(report.integration).toEqual({ label: "mcp", admin: true, privileges: [] });
    expect(report.tools).toHaveLength(tools.length);
    expect(report.tools.every((item) => item.status === "ready")).toBe(true);
    expect(requests.filter((r) => r.path === "/api/search/customer")).toHaveLength(0);
    const text = formatDoctorReport(report, SHOP_URL);
    expect(text).toContain("administrator");
    expect(text).toContain("✓ shop_info");
  });

  it("probes reads when the role is not readable and names the missing privilege", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/search/integration`, forbidden),
      http.post(`${SHOP_URL}/api/search/customer`, forbidden),
      searchHandler(allEmpty),
    );
    const report = await runDoctor(createContext({ allowWrite: true }));
    expect(report.ok).toBe(false);
    expect(report.integration.privileges).toBeNull();
    const byName = new Map(report.tools.map((item) => [item.tool, item]));
    expect(byName.get("customers_search")).toMatchObject({
      status: "blocked",
      detail: expect.stringContaining("customer:read missing"),
    });
    expect(byName.get("products_search")).toMatchObject({ status: "ready" });
    expect(byName.get("entity_schema")).toMatchObject({ status: "ready" });
    expect(byName.get("stock_set")).toMatchObject({
      status: "unknown",
      detail: expect.stringContaining("cannot be verified"),
    });
    const text = formatDoctorReport(report, SHOP_URL);
    expect(text).toContain("✗ customers_search");
    expect(text).toContain("? stock_set");
    expect(text).toContain("Grant the missing privileges");
  });

  it("takes write privileges from the integration's role", async () => {
    mock.use(
      searchHandler({
        ...allEmpty,
        integration: () => ({
          total: 1,
          data: [
            {
              id: "i1",
              label: "support",
              admin: false,
              aclRoles: [{ privileges: ["product:read", "product:update", "order:read"] }],
            },
          ],
        }),
      }),
    );
    const report = await runDoctor(createContext({ allowWrite: true }));
    const byName = new Map(report.tools.map((item) => [item.tool, item]));
    expect(byName.get("stock_set")).toMatchObject({ status: "ready" });
    expect(byName.get("order_note")).toMatchObject({
      status: "blocked",
      detail: "role lacks order:update",
    });
    expect(byName.get("orders_search")).toMatchObject({ status: "ready" });
    expect(report.integration.privileges).toEqual(["order:read", "product:read", "product:update"]);
  });

  it("stops at an unreachable shop", async () => {
    mock.use(http.get(`${SHOP_URL}/api/_info/version`, () => HttpResponse.error()));
    const report = await runDoctor(createContext());
    expect(report.connection.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.tools.every((item) => item.status === "unknown")).toBe(true);
    expect(formatDoctorReport(report, SHOP_URL)).toContain("Connection   failed");
  });
});
