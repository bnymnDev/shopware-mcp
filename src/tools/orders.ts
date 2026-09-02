import { z } from "zod";
import { associations, buildCriteria, searchInputShape } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import {
  dryRunField,
  fullName,
  idSchema,
  num,
  raw,
  rawList,
  sortByKey,
  str,
  strList,
  technicalState,
  toPage,
  translated,
  withFields,
} from "./shared.js";
import { type DryRunResult, defineTool } from "./types.js";

const SEARCH_ASSOCIATIONS = associations([
  "orderCustomer",
  "currency",
  "stateMachineState",
  "transactions.stateMachineState",
  "deliveries.stateMachineState",
]);

const DETAIL_ASSOCIATIONS = associations([
  "orderCustomer",
  "currency",
  "salesChannel",
  "stateMachineState",
  "lineItems",
  "addresses.country",
  "transactions.stateMachineState",
  "transactions.paymentMethod",
  "deliveries.stateMachineState",
  "deliveries.shippingMethod",
  "deliveries.shippingOrderAddress.country",
]);

/** Shopware keeps every transaction; the newest one reflects the current payment state. */
function latestTransaction(order: Raw): Raw | null {
  const transactions = sortByKey(rawList(order.transactions), "createdAt");
  return transactions.at(-1) ?? null;
}

function mapAddress(address: Raw | null) {
  if (!address) return null;
  return {
    id: str(address.id),
    firstName: str(address.firstName),
    lastName: str(address.lastName),
    company: str(address.company),
    street: str(address.street),
    additionalAddressLine1: str(address.additionalAddressLine1),
    zipcode: str(address.zipcode),
    city: str(address.city),
    country: translated(raw(address.country), "name"),
    countryIso: str(raw(address.country)?.iso),
    phoneNumber: str(address.phoneNumber),
  };
}

export function mapOrderSummary(order: Raw) {
  const customer = raw(order.orderCustomer);
  const delivery = rawList(order.deliveries)[0] ?? null;
  return {
    id: str(order.id),
    orderNumber: str(order.orderNumber),
    orderDate: str(order.orderDateTime),
    amountTotal: num(order.amountTotal),
    amountNet: num(order.amountNet),
    currency: str(raw(order.currency)?.isoCode),
    state: technicalState(order.stateMachineState),
    paymentState: technicalState(latestTransaction(order)?.stateMachineState),
    deliveryState: technicalState(delivery?.stateMachineState),
    customer: customer
      ? {
          id: str(customer.customerId),
          name: fullName(customer),
          email: str(customer.email),
          customerNumber: str(customer.customerNumber),
        }
      : null,
    salesChannelId: str(order.salesChannelId),
    updatedAt: str(order.updatedAt),
  };
}

export function mapOrderDetail(order: Raw) {
  const addresses = rawList(order.addresses);
  const billing = addresses.find((address) => address.id === order.billingAddressId) ?? null;
  return {
    ...mapOrderSummary(order),
    shippingTotal: num(order.shippingTotal),
    taxStatus: str(order.taxStatus),
    customerComment: str(order.customerComment),
    salesChannel: translated(raw(order.salesChannel), "name"),
    billingAddress: mapAddress(billing),
    lineItems: sortByKey(rawList(order.lineItems), "position").map((item) => ({
      id: str(item.id),
      type: str(item.type),
      label: str(item.label),
      quantity: num(item.quantity),
      unitPrice: num(item.unitPrice),
      totalPrice: num(item.totalPrice),
      productId: str(item.productId),
      productNumber: str(raw(item.payload)?.productNumber),
      referencedId: str(item.referencedId),
    })),
    transactions: sortByKey(rawList(order.transactions), "createdAt").map((transaction) => ({
      id: str(transaction.id),
      state: technicalState(transaction.stateMachineState),
      paymentMethod:
        translated(raw(transaction.paymentMethod), "distinguishableName") ??
        translated(raw(transaction.paymentMethod), "name"),
      amount: num(raw(transaction.amount)?.totalPrice),
      createdAt: str(transaction.createdAt),
    })),
    deliveries: rawList(order.deliveries).map((delivery) => ({
      id: str(delivery.id),
      state: technicalState(delivery.stateMachineState),
      shippingMethod: translated(raw(delivery.shippingMethod), "name"),
      trackingCodes: strList(delivery.trackingCodes),
      shippingCosts: num(raw(delivery.shippingCosts)?.totalPrice),
      shippingDateEarliest: str(delivery.shippingDateEarliest),
      shippingDateLatest: str(delivery.shippingDateLatest),
      shippingAddress: mapAddress(raw(delivery.shippingOrderAddress)),
    })),
    createdAt: str(order.createdAt),
  };
}

export async function fetchOrderDetail(
  client: ShopwareClient,
  lookup: { orderId?: string; orderNumber?: string },
) {
  const criteria = { associations: DETAIL_ASSOCIATIONS };
  const order = lookup.orderId
    ? await client.findById<Raw>("order", lookup.orderId, criteria)
    : await client.findOne<Raw>("order", "orderNumber", lookup.orderNumber ?? "", criteria);
  return { order, mapped: mapOrderDetail(order) };
}

export const ordersSearch = defineTool({
  name: "orders_search",
  title: "Search orders",
  description:
    "Search orders by term (order number, customer name/email) and/or Criteria filters such as " +
    "stateMachineState.technicalName (open, in_progress, completed, cancelled), " +
    "transactions.stateMachineState.technicalName (paid, open, ...), orderDateTime ranges or " +
    "orderCustomer.email. Newest first by default. Returns compact summaries with totals, " +
    "order/payment/delivery state and customer. Use orders_get for line items and addresses. " +
    "Returns { total, page, limit, items[] }.",
  inputSchema: searchInputShape,
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "orderDateTime", order: "DESC" }],
      associations: SEARCH_ASSOCIATIONS,
    });
    const result = await ctx.client.search<Raw>("order", criteria);
    return toPage(result, criteria, (order) =>
      withFields(mapOrderSummary(order), order, input.fields),
    );
  },
});

export const ordersGet = defineTool({
  name: "orders_get",
  title: "Get order",
  description:
    "Get one order by ID or order number with line items, billing/shipping addresses, " +
    "transactions (payment method and state) and deliveries (shipping method, tracking codes). " +
    "Use it to answer detailed questions about a single order. Returns one object.",
  inputSchema: {
    orderId: idSchema.optional().describe("Order UUID"),
    orderNumber: z.string().min(1).optional().describe("Order number as shown to customers"),
    fields: searchInputShape.fields,
  },
  handler: async (input, ctx) => {
    if (!input.orderId && !input.orderNumber) throw badRequest("Provide orderId or orderNumber");
    const { order, mapped } = await fetchOrderDetail(ctx.client, input);
    return withFields(mapped, order, input.fields);
  },
});

export const orderStateTransition = defineTool({
  name: "order_state_transition",
  title: "Transition order state (guarded)",
  description:
    "Move an order through its state machine: process (open → in_progress), complete " +
    "(in_progress → completed), cancel, or reopen (→ open). Shopware rejects transitions that " +
    "are not allowed from the current state. dryRun=true (default) only returns the request " +
    "that would be sent; call again with dryRun=false to apply. " +
    "Returns { dryRun, wouldSend } or { dryRun: false, result: <updated order> }.",
  write: true,
  annotations: { idempotentHint: false },
  inputSchema: {
    orderId: idSchema.describe("Order UUID"),
    transition: z.enum(["process", "complete", "cancel", "reopen"]),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const path = `/api/_action/order/${input.orderId}/state/${input.transition}`;
    if (input.dryRun) {
      const dry: DryRunResult = {
        dryRun: true,
        wouldSend: { method: "POST", url: ctx.client.url(path), body: {} },
      };
      return dry;
    }
    await ctx.client.request(path, { method: "POST", body: {} });
    const { mapped } = await fetchOrderDetail(ctx.client, { orderId: input.orderId });
    return { dryRun: false, result: mapped };
  },
});
