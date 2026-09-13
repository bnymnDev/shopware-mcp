import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mapBulkResponse, orderDocumentsBulkCreate } from "../src/tools/documents.js";
import { tagAssign } from "../src/tools/tags.js";
import { listScheduledTasks, scheduledTasksList } from "../src/tools/tasks.js";
import { chargeWrites, writesLeft } from "../src/writes.js";
import {
  createContext,
  DOCUMENT_ID,
  fixture,
  invoke,
  lastSearch,
  mock,
  requests,
  SHOP_URL,
  searchHandler,
  searchRequests,
  wouldSendOf,
  writeRequests,
} from "./helpers/shopware.js";

const ctx = createContext({ allowWrite: true });
type Body = Record<string, unknown>;
type Rows = { total: number; data: Array<Record<string, unknown>> };

/** Ten days after the fixture's next-run timestamps. */
const NOW = new Date("2026-09-13T20:35:12.000Z");

describe("scheduled_tasks_list", () => {
  it("summarises statuses and flags waiting tasks that are past their next run", async () => {
    const result = await listScheduledTasks(ctx.client, 15, NOW);
    const body = lastSearch("scheduled-task").body as Body;
    expect(body).toMatchObject({
      limit: 100,
      sort: [{ field: "nextExecutionTime", order: "ASC" }],
    });
    expect(result.total).toBe(7);
    expect(result.summary).toMatchObject({
      byStatus: { scheduled: 5, skipped: 2 },
      overdue: 5,
      failed: 0,
      lastRun: null,
    });
    expect(result.summary.longestOverdueMinutes).toBe(10 * 24 * 60);
    expect(result.summary.stuck).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.tasks[0]).toMatchObject({
      name: "log_entry.cleanup",
      class: "Shopware\\Core\\Framework\\Log\\ScheduledTask\\LogCleanupTask",
      status: "scheduled",
      runIntervalSeconds: 86400,
      lastExecutionTime: null,
      problem: "overdue",
    });
    const skipped = result.tasks.filter((task) => task.status === "skipped");
    expect(skipped.every((task) => task.overdueMinutes === 0 && task.problem === null)).toBe(true);
    expect(result.problems).toHaveLength(5);
  });

  it("treats failed tasks and day-long runs as problems and can return only those", async () => {
    mock.use(
      searchHandler({
        "scheduled-task": () => {
          const rows = fixture<Rows>("scheduled-tasks");
          const [first, second, third] = rows.data;
          if (!first || !second || !third) throw new Error("fixture too small");
          first.status = "failed";
          second.status = "running";
          second.lastExecutionTime = "2026-09-01T00:00:00.000+00:00";
          third.status = "scheduled";
          third.nextExecutionTime = new Date(Date.now() + 60_000).toISOString();
          return { total: 3, data: [first, second, third] };
        },
      }),
    );
    const result = await invoke(scheduledTasksList, { onlyProblems: true }, ctx);
    expect(result.summary).toMatchObject({ failed: 1, overdue: 0, stuck: 1 });
    expect(result.truncated).toBe(false);
    expect(result.tasks.map((task) => task.problem)).toEqual(["failed", "running for over a day"]);
    expect(result.problems).toEqual(result.tasks);
  });

  it("respects the grace period", async () => {
    const strict = await listScheduledTasks(ctx.client, 1, NOW);
    const lenient = await listScheduledTasks(ctx.client, 10_080 * 2, NOW);
    expect(strict.summary.overdue).toBe(5);
    expect(lenient.summary.overdue).toBe(0);
    expect(lenient.problems).toEqual([]);
  });
});

describe("order_documents_bulk_create", () => {
  it("selects paid, not cancelled orders without the document type by default, oldest first", async () => {
    const result = await invoke(orderDocumentsBulkCreate, { type: "invoice", maxOrders: 5 }, ctx);
    const body = lastSearch("order").body as Body;
    expect(body.limit).toBe(5);
    expect(body["total-count-mode"]).toBe(1);
    expect(body.sort).toEqual([{ field: "orderDateTime", order: "ASC" }]);
    const filter = JSON.stringify(body.filter);
    expect(filter).toContain('"transactions.stateMachineState.technicalName","value":"paid"');
    expect(filter).toContain('"cancelled"');
    expect(filter).toContain('"type":"not"');
    expect(filter).toContain('"documents.documentType.technicalName","value":"invoice"');
    expect(result.dryRun).toBe(true);
    if (result.dryRun !== true) throw new Error("expected a dry run");
    expect(result.matching).toBe(3);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({ orderNumber: "10042", paymentState: "paid" });
    const request = wouldSendOf(result);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${SHOP_URL}/api/_action/order/document/invoice/create`);
    expect(request.body).toEqual([
      {
        orderId: "f60718293a4b5c6d7e8f010203040506",
        fileType: "pdf",
        static: false,
        config: {},
      },
    ]);
    expect(writeRequests()).toEqual([]);
  });

  it("takes explicit order ids and prints the comment on every document", async () => {
    const ids = ["f60718293a4b5c6d7e8f010203040506", "a1b2c3d4e5f60718293a4b5c6d7e8f01"];
    const result = await invoke(
      orderDocumentsBulkCreate,
      { type: "delivery_note", orderIds: ids, comment: "Thanks!" },
      ctx,
    );
    const body = lastSearch("order").body as Body;
    expect(body.limit).toBe(2);
    expect(body.filter).toEqual([{ type: "equalsAny", field: "id", value: ids }]);
    const request = wouldSendOf(result);
    expect(request.url).toContain("/document/delivery_note/create");
    expect((request.body as Array<Body>)[0]).toMatchObject({
      config: { documentComment: "Thanks!" },
    });
    if (result.dryRun !== true) throw new Error("expected a dry run");
    expect(result.missing).toEqual(["a1b2c3d4e5f60718293a4b5c6d7e8f01"]);
    expect(result.apply).toEqual({
      type: "delivery_note",
      orderIds: ["f60718293a4b5c6d7e8f010203040506"],
      comment: "Thanks!",
      dryRun: false,
    });
  });

  it("fails clearly when no order matches", async () => {
    mock.use(searchHandler({ order: () => ({ total: 0, data: [] }) }));
    await expect(invoke(orderDocumentsBulkCreate, { type: "invoice" }, ctx)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("No orders"),
    });
  });

  it("posts one request for all orders when applied and reports the outcome", async () => {
    const result = await invoke(
      orderDocumentsBulkCreate,
      { type: "invoice", maxOrders: 10, dryRun: false },
      ctx,
    );
    const post = writeRequests().find((request) =>
      request.path.includes("/document/invoice/create"),
    );
    expect(post?.body).toEqual([
      expect.objectContaining({ orderId: "f60718293a4b5c6d7e8f010203040506" }),
    ]);
    expect(result).toMatchObject({
      dryRun: false,
      created: 1,
      documents: [
        {
          orderId: "f60718293a4b5c6d7e8f010203040506",
          orderNumber: "10042",
          documentId: DOCUMENT_ID,
        },
      ],
      skipped: [],
      errors: [],
    });
    expect(lastSearch("document").body).toMatchObject({
      filter: [{ type: "equalsAny", field: "id", value: [DOCUMENT_ID] }],
    });
    if (result.dryRun !== false) throw new Error("expected a real write");
    expect(result.orders[0]?.orderNumber).toBe("10042");
    expect("writesLeft" in result).toBe(false);
  });

  it("reports an order Shopware skipped without an error instead of guessing", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/_action/order/document/:type/create`, () =>
        HttpResponse.json({ data: [], errors: [] }),
      ),
    );
    const result = await invoke(orderDocumentsBulkCreate, { type: "invoice", dryRun: false }, ctx);
    expect(result).toMatchObject({
      dryRun: false,
      created: 0,
      documents: [],
      skipped: [{ orderId: "f60718293a4b5c6d7e8f010203040506", orderNumber: "10042" }],
      errors: [],
    });
    expect(searchRequests("document")).toEqual([]);
  });

  it("maps per-order errors (keyed by order id) and created ids back to the orders", async () => {
    mock.use(
      http.post(`${SHOP_URL}/api/_action/order/document/:type/create`, () =>
        HttpResponse.json({
          data: [],
          errors: {
            f60718293a4b5c6d7e8f010203040506: [
              {
                status: "400",
                code: "DOCUMENT__GENERATION_ERROR",
                title: "Bad Request",
                detail: "Unable to generate document. Can not generate invoice document",
              },
            ],
          },
        }),
      ),
    );
    const result = await invoke(orderDocumentsBulkCreate, { type: "invoice", dryRun: false }, ctx);
    expect(result).toMatchObject({
      dryRun: false,
      created: 0,
      documents: [],
      errors: [
        {
          orderId: "f60718293a4b5c6d7e8f010203040506",
          orderNumber: "10042",
          code: "DOCUMENT__GENERATION_ERROR",
          detail: expect.stringContaining("Unable to generate"),
        },
      ],
    });
    const orders = [
      { id: "one", orderNumber: "1" },
      { id: "two", orderNumber: "2" },
      { id: "three", orderNumber: "3" },
      { id: "four", orderNumber: "4" },
    ];
    const mixed = mapBulkResponse(
      {
        data: [{ documentId: "aa" }, { documentId: "bb" }, { documentId: "cc" }],
        errors: { two: [{ code: "X" }] },
      },
      orders,
      new Map([
        ["aa", "one"],
        ["bb", "four"],
      ]),
    );
    expect(mixed.documents).toEqual([
      { orderId: "one", orderNumber: "1", documentId: "aa" },
      { orderId: "four", orderNumber: "4", documentId: "bb" },
      { orderId: null, orderNumber: null, documentId: "cc" },
    ]);
    expect(mixed.errors).toEqual([{ orderId: "two", orderNumber: "2", code: "X", detail: null }]);
    expect(mixed.skipped).toEqual([{ orderId: "three", orderNumber: "3" }]);
    expect(mapBulkResponse(undefined, orders, new Map())).toEqual({
      documents: [],
      errors: [],
      skipped: orders.map((order) => ({ orderId: order.id, orderNumber: order.orderNumber })),
    });
  });

  it("charges one write per order against the budget and refuses when it would overrun", async () => {
    const three = () => {
      const rows = fixture<Rows>("orders-search");
      const [order] = rows.data;
      if (!order) throw new Error("fixture too small");
      const data = ["11", "22", "33"].map((suffix) => ({
        ...structuredClone(order),
        id: `${String(order.id).slice(0, 30)}${suffix}`,
      }));
      return { total: 3, data };
    };
    mock.use(searchHandler({ order: three }));

    expect(orderDocumentsBulkCreate.selfCharging).toBe(true);
    const capped = createContext({ allowWrite: true, maxWrites: 3 });
    const ok = await invoke(orderDocumentsBulkCreate, { type: "invoice", dryRun: false }, capped);
    expect(ok).toMatchObject({ dryRun: false, writesLeft: 0 });
    expect(writesLeft(capped)).toBe(0);

    requests.length = 0;
    const tight = createContext({ allowWrite: true, maxWrites: 2 });
    await expect(
      invoke(orderDocumentsBulkCreate, { type: "invoice", dryRun: false }, tight),
    ).rejects.toMatchObject({
      code: "WRITE_BUDGET_EXHAUSTED",
      status: 403,
      message: expect.stringContaining("3 more"),
    });
    expect(writeRequests()).toEqual([]);
    expect(writesLeft(tight)).toBe(2);
  });

  it("never charges the budget for a dry run", async () => {
    const capped = createContext({ allowWrite: true, maxWrites: 1 });
    await invoke(orderDocumentsBulkCreate, { type: "invoice" }, capped);
    expect(writesLeft(capped)).toBe(1);
  });
});

describe("tag_assign", () => {
  const CUSTOMER = "293a4b5c6d7e8f01020304050607080a";
  const VIP = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
  const NEWSLETTER = "1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e";
  const HEX = /^[0-9a-f]{32}$/;

  function withTags(existing: Array<{ id: string; name: string }>) {
    return searchHandler({
      customer: () => ({
        total: 1,
        data: [{ id: CUSTOMER, tags: [{ id: VIP, name: "VIP" }] }],
      }),
      tag: () => ({ total: existing.length, data: existing }),
    });
  }

  it("attaches existing tags, creates missing ones in the same request and removes by name", async () => {
    mock.use(withTags([{ id: NEWSLETTER, name: "Newsletter" }]));
    const result = await invoke(
      tagAssign,
      { entity: "customer", id: CUSTOMER, add: ["Newsletter", "B2B", "b2b"], remove: ["VIP"] },
      ctx,
    );
    const customerSearch = lastSearch("customer").body as Body;
    expect(customerSearch.filter).toEqual([{ type: "equals", field: "id", value: CUSTOMER }]);
    expect(customerSearch.associations).toMatchObject({ tags: {} });
    expect(lastSearch("tag").body).toMatchObject({
      limit: 50,
      filter: [{ type: "equalsAny", field: "name", value: ["Newsletter", "B2B"] }],
    });
    if (result.dryRun !== true) throw new Error("expected a dry run");
    expect(result.unchanged).toBe(false);
    const sent = result.wouldSend;
    if (!Array.isArray(sent)) throw new Error("expected a request list");
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      `PATCH ${SHOP_URL}/api/customer/${CUSTOMER}`,
      `DELETE ${SHOP_URL}/api/customer/${CUSTOMER}/tags/${VIP}`,
    ]);
    expect(sent[0]?.body).toEqual({
      tags: [{ id: NEWSLETTER }, { id: expect.stringMatching(HEX), name: "B2B" }],
    });
    expect(writeRequests()).toEqual([]);
  });

  it("matches tag names regardless of case, preferring the exact spelling", async () => {
    const LOWER = "2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d";
    const EXACT = "3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e";
    mock.use(
      withTags([
        { id: LOWER, name: "wholesale" },
        { id: EXACT, name: "Wholesale" },
        { id: NEWSLETTER, name: "NEWSLETTER" },
      ]),
    );
    const result = await invoke(
      tagAssign,
      {
        entity: "customer",
        id: CUSTOMER,
        add: ["Wholesale", "newsletter", "vip"],
        remove: ["Vip"],
      },
      ctx,
    ).catch((error: unknown) => error);
    expect(result).toMatchObject({ status: 400, message: expect.stringContaining("vip") });

    const applied = await invoke(
      tagAssign,
      { entity: "customer", id: CUSTOMER, add: ["Wholesale", "newsletter", "vip"] },
      ctx,
    );
    if (applied.dryRun !== true) throw new Error("expected a dry run");
    const sent = applied.wouldSend;
    if (!Array.isArray(sent)) throw new Error("expected a request list");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ tags: [{ id: EXACT }, { id: NEWSLETTER }] });
  });

  it("reports an unchanged record when every add exists and every remove is absent", async () => {
    mock.use(withTags([]));
    const result = await invoke(
      tagAssign,
      { entity: "customer", id: CUSTOMER, add: ["vip"], remove: ["Nope"] },
      ctx,
    );
    expect(result).toEqual({ dryRun: true, wouldSend: [], unchanged: true });
    expect(searchRequests("tag")).toEqual([]);
  });

  it("applies the requests in order and returns the resulting tags", async () => {
    const deleted: string[] = [];
    mock.use(
      withTags([]),
      http.delete(`${SHOP_URL}/api/customer/:id/tags/:tagId`, ({ params }) => {
        deleted.push(String(params.tagId));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const result = await invoke(
      tagAssign,
      { entity: "customer", id: CUSTOMER, add: ["Wholesale"], remove: ["VIP"], dryRun: false },
      ctx,
    );
    const writes = writeRequests().map((request) => `${request.method} ${request.path}`);
    expect(writes).toEqual([`PATCH /api/customer/${CUSTOMER}`]);
    expect(writeRequests()[0]?.body).toEqual({
      tags: [{ id: expect.stringMatching(HEX), name: "Wholesale" }],
    });
    expect(deleted).toEqual([VIP]);
    expect(searchRequests("customer")).toHaveLength(2);
    expect(result).toMatchObject({
      dryRun: false,
      result: { entity: "customer", id: CUSTOMER, tags: [{ id: VIP, name: "VIP" }] },
    });
  });

  it("rejects empty and contradictory input", async () => {
    await expect(invoke(tagAssign, { entity: "product", id: CUSTOMER }, ctx)).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    await expect(
      invoke(tagAssign, { entity: "product", id: CUSTOMER, add: ["A"], remove: ["a"] }, ctx),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("A") });
    expect(searchRequests("product")).toEqual([]);
  });
});

describe("write budget", () => {
  it("counts bulk charges together with single writes", () => {
    const capped = createContext({ allowWrite: true, maxWrites: 5 });
    expect(writesLeft(capped)).toBe(5);
    chargeWrites(capped, 1, "a");
    chargeWrites(capped, 3, "b");
    expect(writesLeft(capped)).toBe(1);
    expect(() => chargeWrites(capped, 2, "c")).toThrow(/used 4 of its 5/);
    expect(writesLeft(capped)).toBe(1);
    chargeWrites(capped, 0, "d");
    expect(writesLeft(ctx)).toBeNull();
    expect(DOCUMENT_ID).toHaveLength(32);
  });
});
