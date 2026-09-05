import { shopAudit } from "./audit.js";
import { categoriesList } from "./categories.js";
import { customersGet, customersSearch } from "./customers.js";
import { documentDownload, orderDocumentCreate, orderDocumentsList } from "./documents.js";
import { entitySchema, entitySearch } from "./entities.js";
import {
  orderDeliveryTransition,
  orderNote,
  orderStateTransition,
  ordersGet,
  ordersSearch,
  orderTransactionTransition,
} from "./orders.js";
import { pluginsList } from "./plugins.js";
import { productsGet, productsSearch, productUpdate } from "./products.js";
import { promotionsList, promotionToggle } from "./promotions.js";
import { salesReport } from "./reports.js";
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
  orderDocumentsList,
  documentDownload,
  customersSearch,
  customersGet,
  categoriesList,
  promotionsList,
  pluginsList,
  stockGet,
  salesReport,
  shopAudit,
  entitySchema,
  entitySearch,
  stockSet,
  productUpdate,
  orderStateTransition,
  orderDeliveryTransition,
  orderTransactionTransition,
  orderNote,
  orderDocumentCreate,
  promotionToggle,
];

export const readTools = tools.filter((tool) => !tool.write);
export const writeTools = tools.filter((tool) => tool.write);

export type { ToolContext, ToolDefinition } from "./types.js";
