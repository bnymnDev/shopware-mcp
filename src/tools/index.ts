import { categoriesList } from "./categories.js";
import { customersGet, customersSearch } from "./customers.js";
import { orderStateTransition, ordersGet, ordersSearch } from "./orders.js";
import { pluginsList } from "./plugins.js";
import { productsGet, productsSearch, productUpdate } from "./products.js";
import { promotionsList, promotionToggle } from "./promotions.js";
import { salesChannelsList } from "./sales-channels.js";
import { shopInfo } from "./shop.js";
import { stockGet, stockSet } from "./stock.js";
import type { ToolDefinition } from "./types.js";

/** Every tool, in the order they appear in generated docs. */
export const tools: ToolDefinition[] = [
  shopInfo,
  salesChannelsList,
  productsSearch,
  productsGet,
  ordersSearch,
  ordersGet,
  customersSearch,
  customersGet,
  categoriesList,
  promotionsList,
  pluginsList,
  stockGet,
  stockSet,
  productUpdate,
  orderStateTransition,
  promotionToggle,
];

export const readTools = tools.filter((tool) => !tool.write);
export const writeTools = tools.filter((tool) => tool.write);

export type { ToolContext, ToolDefinition } from "./types.js";
