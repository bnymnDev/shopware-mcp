import { describe, expect, it } from "vitest";
import {
  associations,
  buildCriteria,
  resolveLimit,
  toShopwareFilter,
} from "../src/client/criteria.js";

describe("criteria", () => {
  it("maps filters 1:1 and range to parameters", () => {
    expect(toShopwareFilter({ type: "equals", field: "active", value: true })).toEqual({
      type: "equals",
      field: "active",
      value: true,
    });
    expect(toShopwareFilter({ type: "equalsAny", field: "id", value: ["a", "b"] })).toEqual({
      type: "equalsAny",
      field: "id",
      value: ["a", "b"],
    });
    expect(toShopwareFilter({ type: "range", field: "stock", value: { lt: 5, gte: 0 } })).toEqual({
      type: "range",
      field: "stock",
      parameters: { lt: 5, gte: 0 },
    });
    expect(() => toShopwareFilter({ type: "range", field: "stock", value: 5 })).toThrow();
  });

  it("applies defaults, caps and default sort", () => {
    const criteria = buildCriteria(
      { page: 2, limit: 500 },
      { defaultLimit: 20, defaultSort: [{ field: "name", order: "ASC" }] },
    );
    expect(criteria).toMatchObject({ page: 2, limit: 50, "total-count-mode": 1 });
    expect(criteria.sort).toEqual([{ field: "name", order: "ASC" }]);
    expect(resolveLimit(undefined, 20)).toBe(20);
    expect(resolveLimit(0, 20)).toBe(1);
  });

  it("drops the default sort when a term is given (Shopware ranks by score)", () => {
    const criteria = buildCriteria(
      { page: 1, term: "bag" },
      { defaultLimit: 20, defaultSort: [{ field: "name", order: "ASC" }] },
    );
    expect(criteria.term).toBe("bag");
    expect(criteria.sort).toBeUndefined();
  });

  it("merges extra filters with caller filters", () => {
    const criteria = buildCriteria(
      { page: 1, filter: [{ type: "contains", field: "name", value: "shirt" }] },
      { defaultLimit: 20, extraFilters: [{ type: "equals", field: "parentId", value: null }] },
    );
    expect(criteria.filter).toEqual([
      { type: "equals", field: "parentId", value: null },
      { type: "contains", field: "name", value: "shirt" },
    ]);
  });

  it("builds nested associations from dot paths", () => {
    expect(associations(["manufacturer", "cover.media", "children.options.group"])).toEqual({
      manufacturer: {},
      cover: { associations: { media: {} } },
      children: { associations: { options: { associations: { group: {} } } } },
    });
  });
});
