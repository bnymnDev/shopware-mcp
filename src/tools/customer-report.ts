import { z } from "zod";
import { equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { bucketsOf, countOf, round2, sumOf } from "./aggregations.js";
import {
  change,
  dateRange,
  isoDate,
  notCancelled,
  type Period,
  previousPeriod,
  resolvePeriod,
} from "./periods.js";
import { bool, fullName, idSchema, str } from "./shared.js";
import { defineTool } from "./types.js";

/** Terms buckets are capped; beyond this many distinct customers the ranking is approximate. */
const CUSTOMER_BUCKETS = 1000;

export interface CustomerReportInput {
  from?: string;
  to?: string;
  salesChannelId?: string;
  excludeCancelled: boolean;
  topCustomers: number;
  compareWithPrevious: boolean;
}

function customerFilters(period: Period, input: CustomerReportInput): ShopwareFilter[] {
  const filters = [dateRange("createdAt", period)];
  if (input.salesChannelId) filters.push(equals("salesChannelId", input.salesChannelId));
  return filters;
}

function orderFilters(period: Period, input: CustomerReportInput): ShopwareFilter[] {
  const filters = [dateRange("orderDateTime", period)];
  if (input.salesChannelId) filters.push(equals("salesChannelId", input.salesChannelId));
  if (input.excludeCancelled) filters.push(notCancelled());
  return filters;
}

const percent = (part: number, whole: number): number | null =>
  whole === 0 ? null : round2((part / whole) * 100);

/** Bucket key of a boolean terms aggregation: MySQL yields "0"/"1", other setups true/false. */
const isTrueKey = (key: string | null): boolean => key === "1" || key === "true";

async function periodFigures(client: ShopwareClient, period: Period, input: CustomerReportInput) {
  const [customers, orders] = await Promise.all([
    client.search<Raw>("customer", {
      page: 1,
      limit: 1,
      "total-count-mode": 1,
      filter: customerFilters(period, input),
      includes: { customer: ["id"] },
      aggregations: [
        { name: "byGuest", type: "terms", field: "guest" },
        { name: "byGroup", type: "terms", field: "group.name" },
      ],
    }),
    client.search<Raw>("order", {
      page: 1,
      limit: 1,
      "total-count-mode": 1,
      filter: orderFilters(period, input),
      includes: { order: ["id"] },
      aggregations: [
        { name: "revenue", type: "sum", field: "amountTotal" },
        { name: "distinctCustomers", type: "count", field: "orderCustomer.customerId" },
        { name: "byGuest", type: "terms", field: "orderCustomer.customer.guest" },
        {
          name: "byCustomer",
          type: "terms",
          field: "orderCustomer.customerId",
          limit: CUSTOMER_BUCKETS,
          sort: { field: "_count", order: "DESC" },
          aggregation: { name: "revenue", type: "sum", field: "amountTotal" },
        },
      ],
    }),
  ]);
  const guestBuckets = bucketsOf(customers.aggregations, "byGuest");
  const guests = guestBuckets.filter((b) => isTrueKey(b.key)).reduce((n, b) => n + b.count, 0);
  const guestOrders = bucketsOf(orders.aggregations, "byGuest")
    .filter((b) => isTrueKey(b.key))
    .reduce((n, b) => n + b.count, 0);
  const perCustomer = bucketsOf(orders.aggregations, "byCustomer")
    .filter((bucket) => bucket.key)
    .map((bucket) => ({
      customerId: bucket.key as string,
      orders: bucket.count,
      revenueGross: round2(sumOf(bucket.nested)),
    }))
    .sort((a, b) => b.revenueGross - a.revenueGross || b.orders - a.orders);
  return {
    period,
    newCustomers: {
      total: customers.total,
      registered: customers.total - guests,
      guests,
      byGroup: bucketsOf(customers.aggregations, "byGroup").map((bucket) => ({
        group: bucket.key,
        customers: bucket.count,
      })),
    },
    orders: { total: orders.total, revenueGross: round2(sumOf(orders.aggregations.revenue)) },
    orderingCustomers: countOf(orders.aggregations.distinctCustomers),
    guestOrders,
    perCustomer,
  };
}

export async function buildCustomerReport(client: ShopwareClient, input: CustomerReportInput) {
  const period = resolvePeriod(input, 30);
  const [current, previous] = await Promise.all([
    periodFigures(client, period, input),
    input.compareWithPrevious ? periodFigures(client, previousPeriod(period), input) : null,
  ]);

  const repeat = current.perCustomer.filter((entry) => entry.orders > 1).length;
  const top = current.perCustomer.slice(0, input.topCustomers);
  const customers =
    top.length > 0
      ? await client.search<Raw>("customer", {
          page: 1,
          limit: top.length,
          filter: [
            equalsAny(
              "id",
              top.map((entry) => entry.customerId),
            ),
          ],
          includes: {
            customer: [
              "id",
              "customerNumber",
              "firstName",
              "lastName",
              "email",
              "company",
              "guest",
            ],
          },
        })
      : null;
  const customerById = new Map((customers?.items ?? []).map((c) => [str(c.id), c]));

  const comparison = previous
    ? {
        previousPeriod: {
          from: previous.period.from,
          to: previous.period.to,
          newCustomers: previous.newCustomers.total,
          orderingCustomers: previous.orderingCustomers,
          orders: previous.orders.total,
          revenueGross: previous.orders.revenueGross,
        },
        change: {
          newCustomers: change(current.newCustomers.total, previous.newCustomers.total),
          orderingCustomers: change(current.orderingCustomers, previous.orderingCustomers),
          orders: change(current.orders.total, previous.orders.total),
          revenueGross: change(current.orders.revenueGross, previous.orders.revenueGross),
        },
      }
    : {};

  return {
    period,
    filters: {
      salesChannelId: input.salesChannelId ?? null,
      excludeCancelled: input.excludeCancelled,
    },
    newCustomers: current.newCustomers,
    orderingCustomers: {
      total: current.orderingCustomers,
      repeat,
      repeatShare: percent(repeat, current.orderingCustomers),
      guestOrders: current.guestOrders,
      guestOrderShare: percent(current.guestOrders, current.orders.total),
      ...(current.perCustomer.length >= CUSTOMER_BUCKETS
        ? {
            note:
              `More than ${CUSTOMER_BUCKETS} customers ordered; repeat, repeatShare and ` +
              `topCustomers are based on the ${CUSTOMER_BUCKETS} with the most orders`,
          }
        : {}),
    },
    orders: current.orders,
    ...comparison,
    topCustomers: top.map((entry) => {
      const customer = customerById.get(entry.customerId);
      return {
        ...entry,
        customerNumber: str(customer?.customerNumber),
        name: fullName(customer),
        email: str(customer?.email),
        company: str(customer?.company),
        guest: bool(customer?.guest),
        revenueShare: percent(entry.revenueGross, current.orders.revenueGross),
      };
    }),
  };
}

export const customerReport = defineTool({
  name: "customer_report",
  title: "Customer report",
  description:
    "Customer figures for a period straight from Shopware: new accounts (registered vs guest, " +
    "by customer group), how many distinct customers ordered, the repeat share (two or more " +
    "orders in the period), the guest order share and the top customers by gross revenue " +
    "with their share of the total. compareWithPrevious adds the period of equal length " +
    "before `from` and the change. Defaults to the last 30 days, cancelled orders excluded. " +
    "Returns one object.",
  inputSchema: {
    from: isoDate.optional().describe("Start (inclusive), ISO date. Default: 30 days ago"),
    to: isoDate
      .optional()
      .describe("End (inclusive; a date without time covers the whole day). Default: now"),
    salesChannelId: idSchema.optional().describe("Restrict to one sales channel"),
    excludeCancelled: z.boolean().default(true),
    topCustomers: z.number().int().min(1).max(50).default(10),
    compareWithPrevious: z
      .boolean()
      .default(false)
      .describe("Also report the preceding period of equal length and the change"),
  },
  handler: (input, ctx) => buildCustomerReport(ctx.client, input),
});
