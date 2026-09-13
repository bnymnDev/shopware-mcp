import { associations, buildCriteria, searchInputShape } from "../client/criteria.js";
import type { Raw } from "../client/index.js";
import { bool, num, raw, rawList, str, toPage, translated, withFields } from "./shared.js";
import { defineTool } from "./types.js";

/** Payment and shipping methods: what a shop offers at checkout and where. */

const PAYMENT_ASSOCIATIONS = associations(["availabilityRule", "salesChannels"]);
const SHIPPING_ASSOCIATIONS = associations(["availabilityRule", "salesChannels", "deliveryTime"]);

function mapMethodBase(method: Raw) {
  return {
    id: str(method.id),
    name: translated(method, "name"),
    technicalName: str(method.technicalName),
    active: bool(method.active),
    position: num(method.position),
    availabilityRule: str(raw(method.availabilityRule)?.name),
    /** Sales channels the method is assigned to (it must also be active to be offered). */
    salesChannels: rawList(method.salesChannels)
      .map((channel) => translated(channel, "name"))
      .filter((name): name is string => name !== null),
  };
}

export function mapPaymentMethod(method: Raw) {
  return {
    ...mapMethodBase(method),
    distinguishableName: translated(method, "distinguishableName"),
    handler: str(method.formattedHandlerIdentifier) ?? str(method.handlerIdentifier),
    afterOrderEnabled: bool(method.afterOrderEnabled),
    pluginId: str(method.pluginId),
  };
}

export function mapShippingMethod(method: Raw) {
  return {
    ...mapMethodBase(method),
    deliveryTime: translated(raw(method.deliveryTime), "name"),
    trackingUrl: str(method.trackingUrl),
    taxType: str(method.taxType),
  };
}

export const paymentMethodsList = defineTool({
  name: "payment_methods_list",
  title: "List payment methods",
  description:
    "List payment methods with active flag, handler (plugin), availability rule and the sales " +
    "channels they are assigned to. Filter e.g. active=true or salesChannels.id. Use it for " +
    "'which payment methods do we offer?' and to explain why one is missing at checkout. " +
    "Returns { total, page, limit, items[] }.",
  inputSchema: searchInputShape,
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "position", order: "ASC" }],
      associations: PAYMENT_ASSOCIATIONS,
    });
    const result = await ctx.client.search<Raw>("payment-method", criteria);
    return toPage(result, criteria, (method) =>
      withFields(mapPaymentMethod(method), method, input.fields),
    );
  },
});

export const shippingMethodsList = defineTool({
  name: "shipping_methods_list",
  title: "List shipping methods",
  description:
    "List shipping methods with active flag, delivery time, tracking URL pattern, availability " +
    "rule and the sales channels they are assigned to. Filter e.g. active=true or " +
    "salesChannels.id. Returns { total, page, limit, items[] }.",
  inputSchema: searchInputShape,
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "position", order: "ASC" }],
      associations: SHIPPING_ASSOCIATIONS,
    });
    const result = await ctx.client.search<Raw>("shipping-method", criteria);
    return toPage(result, criteria, (method) =>
      withFields(mapShippingMethod(method), method, input.fields),
    );
  },
});
