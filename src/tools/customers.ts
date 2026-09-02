import { z } from "zod";
import { associations, buildCriteria, searchInputShape } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest, ShopwareMcpError } from "../errors.js";
import { logger } from "../logger.js";
import {
  bool,
  fullName,
  idSchema,
  num,
  raw,
  rawList,
  str,
  toPage,
  translated,
  withFields,
} from "./shared.js";
import { defineTool } from "./types.js";

const SEARCH_ASSOCIATIONS = associations(["group"]);
const DETAIL_ASSOCIATIONS = associations([
  "group",
  "salesChannel",
  "addresses.country",
  "lastPaymentMethod",
]);

export function mapCustomerSummary(customer: Raw) {
  return {
    id: str(customer.id),
    customerNumber: str(customer.customerNumber),
    email: str(customer.email),
    firstName: str(customer.firstName),
    lastName: str(customer.lastName),
    name: fullName(customer),
    company: str(customer.company),
    group: translated(raw(customer.group), "name"),
    active: bool(customer.active),
    guest: bool(customer.guest),
    orderCount: num(customer.orderCount),
    orderTotalAmount: num(customer.orderTotalAmount),
    lastOrderDate: str(customer.lastOrderDate),
    lastLogin: str(customer.lastLogin),
    salesChannelId: str(customer.salesChannelId),
    createdAt: str(customer.createdAt),
  };
}

function mapAddress(customer: Raw, address: Raw) {
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
    isDefaultBilling: address.id === customer.defaultBillingAddressId,
    isDefaultShipping: address.id === customer.defaultShippingAddressId,
  };
}

/**
 * `defaultPaymentMethodId` exists on Shopware 6.6 but was removed in 6.7, so it is resolved with
 * a tolerant secondary lookup instead of an association that would fail on newer versions.
 */
async function resolvePaymentMethod(
  client: ShopwareClient,
  paymentMethodId: string | null,
): Promise<string | null> {
  if (!paymentMethodId) return null;
  try {
    const method = await client.findById<Raw>("payment-method", paymentMethodId);
    return translated(method, "distinguishableName") ?? translated(method, "name");
  } catch (error) {
    if (error instanceof ShopwareMcpError) {
      logger.debug("payment method lookup failed", { code: error.code });
      return null;
    }
    throw error;
  }
}

export async function fetchCustomerDetail(
  client: ShopwareClient,
  lookup: { customerId?: string; customerNumber?: string; email?: string },
) {
  const criteria = { associations: DETAIL_ASSOCIATIONS };
  let customer: Raw;
  if (lookup.customerId) {
    customer = await client.findById<Raw>("customer", lookup.customerId, criteria);
  } else if (lookup.customerNumber) {
    customer = await client.findOne<Raw>(
      "customer",
      "customerNumber",
      lookup.customerNumber,
      criteria,
    );
  } else {
    customer = await client.findOne<Raw>("customer", "email", lookup.email ?? "", criteria);
  }
  const defaultPaymentMethod = await resolvePaymentMethod(
    client,
    str(customer.defaultPaymentMethodId),
  );
  const mapped = {
    ...mapCustomerSummary(customer),
    title: str(customer.title),
    birthday: str(customer.birthday),
    salesChannel: translated(raw(customer.salesChannel), "name"),
    defaultPaymentMethod,
    lastPaymentMethod:
      translated(raw(customer.lastPaymentMethod), "distinguishableName") ??
      translated(raw(customer.lastPaymentMethod), "name"),
    addresses: rawList(customer.addresses).map((address) => mapAddress(customer, address)),
    updatedAt: str(customer.updatedAt),
  };
  return { customer, mapped };
}

export const customersSearch = defineTool({
  name: "customers_search",
  title: "Search customers",
  description:
    "Search customers by term (name, email, customer number) and/or Criteria filters such as " +
    "email, active, guest, group.name or lastOrderDate ranges. Returns compact summaries with " +
    "group, order count and last order date. Use customers_get for addresses and payment " +
    "method. Returns { total, page, limit, items[] }.",
  inputSchema: searchInputShape,
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "customerNumber", order: "ASC" }],
      associations: SEARCH_ASSOCIATIONS,
    });
    const result = await ctx.client.search<Raw>("customer", criteria);
    return toPage(result, criteria, (customer) =>
      withFields(mapCustomerSummary(customer), customer, input.fields),
    );
  },
});

export const customersGet = defineTool({
  name: "customers_get",
  title: "Get customer",
  description:
    "Get one customer by ID, customer number or email, including all addresses (with default " +
    "billing/shipping flags), customer group, default and last used payment method. " +
    "Returns one object.",
  inputSchema: {
    customerId: idSchema.optional().describe("Customer UUID"),
    customerNumber: z.string().min(1).optional(),
    email: z.string().min(3).optional(),
    fields: searchInputShape.fields,
  },
  handler: async (input, ctx) => {
    if (!input.customerId && !input.customerNumber && !input.email) {
      throw badRequest("Provide customerId, customerNumber or email");
    }
    const { customer, mapped } = await fetchCustomerDetail(ctx.client, input);
    return withFields(mapped, customer, input.fields);
  },
});
