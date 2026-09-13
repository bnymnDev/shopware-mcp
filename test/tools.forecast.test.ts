import { describe, expect, it } from "vitest";
import { entitySearch } from "../src/tools/entities.js";
import { buildStockForecast, stockForecast } from "../src/tools/forecast.js";
import {
  createContext,
  invoke,
  lastSearch,
  mock,
  searchHandler,
  searchRequests,
} from "./helpers/shopware.js";

const ctx = createContext();
type Body = Record<string, unknown>;

describe("stock_forecast", () => {
  it("joins sales velocity with available stock and flags short cover", async () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    const forecast = await buildStockForecast(
      ctx.client,
      { days: 30, horizon: 14, restockDays: 30, limit: 20 },
      now,
    );
    const sales = lastSearch("order-line-item").body as Body;
    expect(sales.filter).toEqual([
      { type: "equals", field: "type", value: "product" },
      {
        type: "range",
        field: "order.orderDateTime",
        parameters: { gte: "2026-08-14T12:00:00.000Z" },
      },
      {
        type: "not",
        operator: "and",
        queries: [
          { type: "equals", field: "order.stateMachineState.technicalName", value: "cancelled" },
        ],
      },
    ]);
    const products = lastSearch("product").body as Body;
    // Only candidates with sales, active, and with less stock than the fastest seller needs.
    expect(products.filter).toEqual([
      {
        type: "equalsAny",
        field: "id",
        value: expect.arrayContaining(["a1b2c3d4e5f60718293a4b5c6d7e8f01"]),
      },
      { type: "equals", field: "active", value: true },
      { type: "range", field: "availableStock", parameters: { lt: 28 } },
    ]);
    expect(forecast).toMatchObject({ window: { days: 30 }, horizon: 14, total: 2 });
    expect(forecast.items.map((item) => item.productNumber)).toEqual(["SW10002", "SW10001"]);
    expect(forecast.items[1]).toMatchObject({
      productNumber: "SW10001",
      availableStock: 10,
      soldInWindow: 60,
      perDay: 2,
      daysOfCover: 5,
      runsOutOn: "2026-09-18",
      suggestedReorder: 78,
    });
    expect(forecast.items[0]).toMatchObject({
      daysOfCover: 0,
      runsOutOn: "2026-09-13",
      suggestedReorder: 5,
    });
  });

  it("returns nothing without sales and honours the horizon", async () => {
    mock.use(
      searchHandler({ "order-line-item": () => ({ total: 0, data: [], aggregations: {} }) }),
    );
    const empty = await invoke(stockForecast, {}, ctx);
    expect(empty).toMatchObject({ total: 0, items: [] });
    expect(searchRequests("product")).toHaveLength(0);

    mock.use(searchHandler());
    const tight = await invoke(stockForecast, { horizon: 3, restockDays: 7, limit: 1 }, ctx);
    // SW10001 has five days of cover, so only SW10002 is inside a three-day horizon.
    expect(tight.total).toBe(1);
    expect(tight.items[0]).toMatchObject({ productNumber: "SW10002", suggestedReorder: 1 });
  });
});

describe("entity_search aggregations", () => {
  it("passes aggregations through and returns them scrubbed", async () => {
    mock.use(
      searchHandler({
        order: () => ({
          total: 60,
          data: [],
          aggregations: {
            byPayment: {
              name: "byPayment",
              apiAlias: "byPayment_aggregation",
              buckets: [{ key: "Invoice", count: 40, apiAlias: "aggregation_bucket" }],
            },
          },
        }),
      }),
    );
    const result = await invoke(
      entitySearch,
      {
        entity: "order",
        limit: 1,
        aggregations: [
          {
            name: "byPayment",
            type: "terms",
            field: "transactions.paymentMethod.name",
            sort: { field: "_count", order: "DESC" },
            aggregation: { name: "revenue", type: "sum", field: "amountTotal" },
          },
        ],
      },
      ctx,
    );
    expect(lastSearch("order").body).toMatchObject({
      limit: 1,
      aggregations: [
        {
          name: "byPayment",
          type: "terms",
          field: "transactions.paymentMethod.name",
          sort: { field: "_count", order: "DESC" },
          aggregation: { name: "revenue", type: "sum", field: "amountTotal" },
        },
      ],
    });
    expect(result.aggregations).toEqual({
      byPayment: { name: "byPayment", buckets: [{ key: "Invoice", count: 40 }] },
    });
  });

  it("refuses aggregations over credential fields", async () => {
    await expect(
      invoke(
        entitySearch,
        { entity: "customer", aggregations: [{ name: "x", type: "terms", field: "password" }] },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      invoke(
        entitySearch,
        {
          entity: "order",
          aggregations: [
            {
              name: "x",
              type: "terms",
              field: "id",
              aggregation: { name: "y", type: "terms", field: "orderCustomer.customer.hash" },
            },
          ],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("entity_search path guard", () => {
  it("refuses paths that hop into blocked entities, in filters, sorts, associations and aggregations", async () => {
    const blocked = { code: "BAD_REQUEST", detail: expect.stringContaining('"user"') };
    await expect(
      invoke(
        entitySearch,
        { entity: "customer", filter: [{ type: "equals", field: "createdBy.email", value: "x" }] },
        ctx,
      ),
    ).rejects.toMatchObject(blocked);
    await expect(
      invoke(entitySearch, { entity: "customer", sort: [{ field: "createdBy.username" }] }, ctx),
    ).rejects.toMatchObject(blocked);
    await expect(
      invoke(entitySearch, { entity: "customer", associations: ["createdBy"] }, ctx),
    ).rejects.toMatchObject(blocked);
    await expect(
      invoke(
        entitySearch,
        {
          entity: "customer",
          aggregations: [{ name: "x", type: "terms", field: "createdBy.username" }],
        },
        ctx,
      ),
    ).rejects.toMatchObject(blocked);
    // An association into an exposed entity is fine, and unknown segments are left to Shopware.
    await invoke(
      entitySearch,
      {
        entity: "customer",
        filter: [{ type: "equals", field: "salesChannel.name", value: "Storefront" }],
        sort: [{ field: "group.name" }],
        aggregations: [{ name: "x", type: "terms", field: "salesChannel.typeId" }],
      },
      ctx,
    );
    await invoke(
      entitySearch,
      { entity: "customer", filter: [{ type: "equals", field: "nonexistent.deep", value: 1 }] },
      ctx,
    );
  });
});

describe("stock_forecast options", () => {
  it("restricts sales to one channel, falls back to stock and notes the candidate cap", async () => {
    const channel = "01a068fb91ad7260939028219e459a91";
    const buckets = Array.from({ length: 1000 }, (_, index) => ({
      key: index === 0 ? "a1b2c3d4e5f60718293a4b5c6d7e8f01" : index.toString(16).padStart(32, "0"),
      count: 1,
      quantity: { sum: 30 },
    }));
    mock.use(
      searchHandler({
        "order-line-item": () => ({
          total: 1000,
          data: [],
          aggregations: { byProduct: { buckets } },
        }),
        product: () => ({
          total: 1,
          data: [
            {
              id: "a1b2c3d4e5f60718293a4b5c6d7e8f01",
              productNumber: "SW10001",
              name: "Bag",
              stock: 4,
              availableStock: null,
            },
          ],
        }),
      }),
    );
    const forecast = await invoke(stockForecast, { salesChannelId: channel }, ctx);
    const sales = lastSearch("order-line-item").body as Body;
    expect(sales.filter).toContainEqual({
      type: "equals",
      field: "order.salesChannelId",
      value: channel,
    });
    expect(forecast.notes).toEqual([
      "Only the 1000 products with the most order lines were considered",
    ]);
    expect(forecast.items[0]).toMatchObject({ productNumber: "SW10001", daysOfCover: 4, stock: 4 });
  });
});
