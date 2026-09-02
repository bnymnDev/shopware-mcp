import { associations, buildCriteria, searchInputShape } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { bool, rawList, str, toPage, translated, withFields } from "./shared.js";
import { defineTool } from "./types.js";

const ASSOCIATIONS = associations(["domains", "type", "currency", "language"]);

export function mapSalesChannel(channel: Raw) {
  const type = channel.type as Raw | undefined;
  return {
    id: str(channel.id),
    name: translated(channel, "name"),
    type: translated(type, "name"),
    typeId: str(channel.typeId),
    active: bool(channel.active),
    maintenance: bool(channel.maintenance),
    currency: str((channel.currency as Raw | undefined)?.isoCode),
    language: str((channel.language as Raw | undefined)?.name),
    domains: rawList(channel.domains).map((domain) => ({
      id: str(domain.id),
      url: str(domain.url),
      languageId: str(domain.languageId),
      currencyId: str(domain.currencyId),
    })),
  };
}

export async function listSalesChannels(client: ShopwareClient, defaultLimit: number) {
  const criteria = buildCriteria({ page: 1 }, { defaultLimit, associations: ASSOCIATIONS });
  criteria.sort = [{ field: "name", order: "ASC" }];
  const result = await client.search<Raw>("sales-channel", criteria);
  return toPage(result, criteria, mapSalesChannel);
}

export const salesChannelsList = defineTool({
  name: "sales_channels_list",
  title: "List sales channels",
  description:
    "List sales channels (storefronts, headless APIs, marketplaces) with their type, domains and " +
    "active flag. Use it to find the sales channel or domain an order or product belongs to. " +
    "Returns { total, page, limit, items[] }.",
  inputSchema: searchInputShape,
  handler: async (input, ctx) => {
    const criteria = buildCriteria(input, {
      defaultLimit: ctx.config.defaultLimit,
      defaultSort: [{ field: "name", order: "ASC" }],
      associations: ASSOCIATIONS,
    });
    const result = await ctx.client.search<Raw>("sales-channel", criteria);
    return toPage(result, criteria, (channel) =>
      withFields(mapSalesChannel(channel), channel, input.fields),
    );
  },
});
