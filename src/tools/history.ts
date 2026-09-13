import { z } from "zod";
import { associations, equalsAny } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { idSchema, raw, rawList, str, technicalState } from "./shared.js";
import { defineTool } from "./types.js";

const HISTORY_ASSOCIATIONS = associations([
  "fromStateMachineState",
  "toStateMachineState",
  "user",
  "integration",
]);

/** Who triggered a transition: an admin user, an API integration, or Shopware itself. */
function actor(entry: Raw) {
  const user = raw(entry.user);
  if (user) {
    return {
      type: "user" as const,
      name:
        [str(user.firstName), str(user.lastName)].filter(Boolean).join(" ") || str(user.username),
    };
  }
  const integration = raw(entry.integration);
  if (integration) return { type: "integration" as const, name: str(integration.label) };
  return { type: "system" as const, name: null };
}

export function mapHistoryEntry(entry: Raw) {
  return {
    at: str(entry.createdAt),
    entity: str(entry.entityName),
    referencedId: str(entry.referencedId),
    action: str(entry.transitionActionName),
    from: technicalState(entry.fromStateMachineState),
    to: technicalState(entry.toStateMachineState),
    by: actor(entry),
  };
}

export async function fetchOrderHistory(
  client: ShopwareClient,
  lookup: { orderId?: string; orderNumber?: string },
  limit: number,
) {
  const criteria = {
    includes: {
      order: ["id", "orderNumber", "orderDateTime", "deliveries", "transactions"],
      order_delivery: ["id"],
      order_transaction: ["id"],
    },
    associations: associations(["deliveries", "transactions"]),
  };
  const order = lookup.orderId
    ? await client.findById<Raw>("order", lookup.orderId, criteria)
    : await client.findOne<Raw>("order", "orderNumber", lookup.orderNumber ?? "", criteria);
  const orderId = String(order.id);
  const ids = [
    orderId,
    ...rawList(order.deliveries).map((delivery) => String(delivery.id)),
    ...rawList(order.transactions).map((transaction) => String(transaction.id)),
  ];
  // Newest first from Shopware so a cap keeps the recent transitions; oldest first in the output.
  const history = await client.search<Raw>("state-machine-history", {
    page: 1,
    limit,
    "total-count-mode": 1,
    filter: [equalsAny("referencedId", ids)],
    sort: [{ field: "createdAt", order: "DESC" }],
    associations: HISTORY_ASSOCIATIONS,
  });
  const entries = history.items.map(mapHistoryEntry).reverse();
  return {
    orderId,
    orderNumber: str(order.orderNumber),
    orderDate: str(order.orderDateTime),
    total: history.total,
    entries,
    ...(history.total > entries.length
      ? { note: `Showing the newest ${entries.length} of ${history.total} transitions` }
      : {}),
  };
}

export const orderHistory = defineTool({
  name: "order_history",
  title: "Order history",
  description:
    "The state history of one order: every order, payment and delivery transition in " +
    "chronological order with the previous and new state, the action name and who triggered " +
    "it (admin user, API integration or the system). Use it for 'what happened to this order " +
    "and when?'. Orders imported without transitions have an empty history. When there are " +
    "more transitions than `limit`, the newest ones are kept. " +
    "Returns { orderId, orderNumber, orderDate, total, entries[], note? }.",
  inputSchema: {
    orderId: idSchema.optional().describe("Order UUID"),
    orderNumber: z.string().min(1).optional().describe("Order number as shown to the customer"),
    limit: z.number().int().min(1).max(200).default(100),
  },
  handler: async (input, ctx) => {
    if (!input.orderId && !input.orderNumber) throw badRequest("Provide orderId or orderNumber");
    return fetchOrderHistory(ctx.client, input, input.limit);
  },
});
