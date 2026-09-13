import { shopAudit } from "./audit.js";
import { categoriesList } from "./categories.js";
import { customerReport } from "./customer-report.js";
import { customersGet, customersSearch, customerUpdate } from "./customers.js";
import {
  documentDownload,
  orderDocumentCreate,
  orderDocumentsBulkCreate,
  orderDocumentsList,
} from "./documents.js";
import { entitySchema, entitySearch } from "./entities.js";
import { stockForecast } from "./forecast.js";
import { orderHistory } from "./history.js";
import { productCoverSet } from "./media.js";
import { paymentMethodsList, shippingMethodsList } from "./methods.js";
import {
  orderDeliveryTransition,
  orderNote,
  orderStateTransition,
  ordersGet,
  ordersSearch,
  orderTransactionTransition,
} from "./orders.js";
import { pluginsList } from "./plugins.js";
import { productCreate, productsGet, productsSearch, productUpdate } from "./products.js";
import { promotionCreate, promotionsList, promotionToggle } from "./promotions.js";
import { salesReport } from "./reports.js";
import { reviewModerate, reviewsSearch } from "./reviews.js";
import { salesChannelsList } from "./sales-channels.js";
import { shopSettings } from "./settings.js";
import { shopInfo } from "./shop.js";
import { stockGet, stockSet } from "./stock.js";
import { tagAssign } from "./tags.js";
import { scheduledTasksList } from "./tasks.js";
import type { ToolDefinition } from "./types.js";

/** Every tool, in the order they appear in generated docs. */
export const tools: ToolDefinition[] = [
  shopInfo,
  shopSettings,
  salesChannelsList,
  productsSearch,
  productsGet,
  ordersSearch,
  ordersGet,
  orderHistory,
  orderDocumentsList,
  documentDownload,
  customersSearch,
  customersGet,
  categoriesList,
  promotionsList,
  reviewsSearch,
  paymentMethodsList,
  shippingMethodsList,
  pluginsList,
  scheduledTasksList,
  stockGet,
  stockForecast,
  salesReport,
  customerReport,
  shopAudit,
  entitySchema,
  entitySearch,
  stockSet,
  productUpdate,
  productCreate,
  productCoverSet,
  orderStateTransition,
  orderDeliveryTransition,
  orderTransactionTransition,
  orderNote,
  orderDocumentCreate,
  orderDocumentsBulkCreate,
  promotionToggle,
  promotionCreate,
  customerUpdate,
  reviewModerate,
  tagAssign,
];

export const readTools = tools.filter((tool) => !tool.write);
export const writeTools = tools.filter((tool) => tool.write);

export type { ToolContext, ToolDefinition } from "./types.js";
