import { z } from "zod";
import { associations, equals, equalsAny } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest, ShopwareMcpError } from "../errors.js";
import { chargeWrites, writesLeft } from "../writes.js";
import { mapOrderSummary } from "./orders.js";

type OrderSummary = ReturnType<typeof mapOrderSummary>;

import { notCancelled } from "./periods.js";
import { bool, dryRunField, idSchema, raw, rawList, str } from "./shared.js";
import { type Attachment, type DryRunResult, defineTool } from "./types.js";

/** Larger files stay in the shop; a base64 blob beyond this would swamp any host. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

const DOCUMENT_ASSOCIATIONS = associations(["documentType", "order"]);
const DOCUMENT_INCLUDES = {
  document: [
    "id",
    "documentNumber",
    "fileType",
    "sent",
    "static",
    "orderId",
    "createdAt",
    "deepLinkCode",
    "documentType",
    "order",
  ],
  document_type: ["technicalName"],
  order: ["orderNumber"],
};

export function mapDocument(document: Raw) {
  return {
    id: str(document.id),
    type: str(raw(document.documentType)?.technicalName),
    documentNumber: str(document.documentNumber),
    fileType: str(document.fileType),
    sent: bool(document.sent),
    static: bool(document.static),
    orderId: str(document.orderId),
    orderNumber: str(raw(document.order)?.orderNumber),
    createdAt: str(document.createdAt),
  };
}

async function resolveOrder(
  client: ShopwareClient,
  lookup: { orderId?: string; orderNumber?: string },
): Promise<{ id: string; orderNumber: string | null }> {
  if (!lookup.orderId && !lookup.orderNumber) throw badRequest("Provide orderId or orderNumber");
  const criteria = { includes: { order: ["id", "orderNumber"] } };
  const order = lookup.orderId
    ? await client.findById<Raw>("order", lookup.orderId, criteria)
    : await client.findOne<Raw>("order", "orderNumber", lookup.orderNumber ?? "", criteria);
  return { id: String(order.id), orderNumber: str(order.orderNumber) };
}

export async function listDocuments(client: ShopwareClient, orderId: string) {
  const result = await client.search<Raw>("document", {
    page: 1,
    limit: 50,
    filter: [equals("orderId", orderId)],
    sort: [{ field: "createdAt", order: "DESC" }],
    associations: DOCUMENT_ASSOCIATIONS,
    includes: DOCUMENT_INCLUDES,
  });
  return { total: result.total, items: result.items.map(mapDocument) };
}

export const orderDocumentsList = defineTool({
  name: "order_documents_list",
  title: "List order documents",
  description:
    "List the documents generated for one order: invoices, delivery notes, credit notes and " +
    "cancellation invoices, with document number, type, creation date and whether they were " +
    "sent. Use document_download to fetch one as PDF. Returns { orderId, orderNumber, total, " +
    "items[] }.",
  inputSchema: {
    orderId: idSchema.optional().describe("Order UUID"),
    orderNumber: z.string().min(1).optional().describe("Order number as shown to customers"),
  },
  handler: async (input, ctx) => {
    const order = await resolveOrder(ctx.client, input);
    const documents = await listDocuments(ctx.client, order.id);
    return { orderId: order.id, orderNumber: order.orderNumber, ...documents };
  },
});

export const documentDownload = defineTool({
  name: "document_download",
  title: "Download document PDF",
  description:
    "Fetch one order document (invoice, delivery note, credit note, cancellation invoice) as a " +
    "PDF. The file is returned to the host as an embedded resource next to the document's " +
    "metadata; the model sees the metadata only. Get the documentId from order_documents_list. " +
    "Read-only, nothing is marked as sent. Returns { id, type, documentNumber, orderNumber, " +
    "mimeType, bytes, attachments[] }.",
  inputSchema: {
    documentId: idSchema.describe("Document UUID from order_documents_list"),
  },
  handler: async (input, ctx) => {
    const document = await ctx.client.findById<Raw>("document", input.documentId, {
      associations: DOCUMENT_ASSOCIATIONS,
      includes: DOCUMENT_INCLUDES,
    });
    const code = str(document.deepLinkCode);
    if (!code) {
      throw new ShopwareMcpError(500, "DOCUMENT_UNAVAILABLE", "Document has no download code");
    }
    const file = await ctx.client.requestBinary(
      `/api/_action/document/${input.documentId}/${code}?download=1`,
    );
    if (file.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new ShopwareMcpError(
        413,
        "DOCUMENT_TOO_LARGE",
        `Document is ${file.bytes.byteLength} bytes; the limit is ${MAX_DOCUMENT_BYTES}`,
      );
    }
    const meta = mapDocument(document);
    const mimeType = file.contentType?.split(";")[0]?.trim() || "application/pdf";
    const extension = mimeType === "application/pdf" ? "pdf" : (meta.fileType ?? "bin");
    const attachment: Attachment = {
      uri: `shopware://document/${input.documentId}`,
      name: `${meta.type ?? "document"}-${meta.documentNumber ?? input.documentId}.${extension}`,
      mimeType,
      bytes: file.bytes.byteLength,
      base64: Buffer.from(file.bytes).toString("base64"),
    };
    return { ...meta, mimeType, bytes: attachment.bytes, attachments: [attachment] };
  },
});

interface CreateResponse {
  data?: Array<{ documentId?: unknown }>;
  /** Shopware keys errors by order id; an empty PHP array arrives as `[]`. */
  errors?: unknown;
}

interface BulkError {
  orderId: string;
  orderNumber: string | null;
  code: string | null;
  detail: string | null;
}

interface BulkOrder {
  id: string;
  orderNumber: string | null;
}

/** The ids Shopware reports as created, in its own order. */
export function createdDocumentIds(response: CreateResponse | undefined): string[] {
  return rawList(response?.data)
    .map((entry) => str(entry.documentId))
    .filter((id): id is string => id !== null);
}

/**
 * Shopware answers a bulk request with the created ids (without their orders) and the errors
 * keyed by order id. An order it skipped without an error, for example one that already has
 * the document, appears in neither list, so the ids are attributed by reading the documents
 * back (`owners`: document id to order id) rather than by position.
 */
export function mapBulkResponse(
  response: CreateResponse | undefined,
  orders: BulkOrder[],
  owners: Map<string, string>,
) {
  const errors: BulkError[] = [];
  const failed = new Set<string>();
  const rawErrors = response?.errors;
  if (rawErrors && typeof rawErrors === "object" && !Array.isArray(rawErrors)) {
    for (const [orderId, entries] of Object.entries(rawErrors as Record<string, unknown>)) {
      failed.add(orderId);
      const first = rawList(entries)[0] ?? raw(entries);
      errors.push({
        orderId,
        orderNumber: orders.find((order) => order.id === orderId)?.orderNumber ?? null,
        code: str(first?.code),
        detail: str(first?.detail) ?? str(first?.title),
      });
    }
  }
  const ids = createdDocumentIds(response);
  const documents: Array<{
    orderId: string | null;
    orderNumber: string | null;
    documentId: string;
  }> = [];
  const attributed = new Set<string>();
  for (const order of orders) {
    for (const documentId of ids) {
      if (owners.get(documentId) !== order.id) continue;
      attributed.add(documentId);
      documents.push({ orderId: order.id, orderNumber: order.orderNumber, documentId });
    }
  }
  for (const documentId of ids) {
    if (!attributed.has(documentId)) {
      documents.push({ orderId: null, orderNumber: null, documentId });
    }
  }
  const skipped = orders
    .filter((order) => !failed.has(order.id) && !documents.some((d) => d.orderId === order.id))
    .map((order) => ({ orderId: order.id, orderNumber: order.orderNumber }));
  return { documents, errors, skipped };
}

/** Which order each of the given documents belongs to, read back from the shop. */
async function documentOwners(client: ShopwareClient, ids: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (ids.length === 0) return owners;
  const result = await client.search<Raw>("document", {
    page: 1,
    limit: ids.length,
    filter: [equalsAny("id", ids)],
    includes: { document: ["id", "orderId"] },
  });
  for (const document of result.items) {
    const id = str(document.id);
    const orderId = str(document.orderId);
    if (id && orderId) owners.set(id, orderId);
  }
  return owners;
}

export const orderDocumentCreate = defineTool({
  name: "order_document_create",
  title: "Create order document (guarded)",
  description:
    "Generate a document for an order with Shopware's own document generator: invoice, " +
    "delivery_note, credit_note, storno (cancellation invoice) or another installed document " +
    "type by its technical name. Shopware assigns the document number from its number range " +
    "and refuses what its rules forbid, for example a storno without an invoice. Nothing is " +
    "sent to the customer. dryRun=true (default) returns the request that would be sent; call " +
    "again with dryRun=false to apply. Returns { dryRun, wouldSend } or " +
    "{ dryRun: false, result: <document> }.",
  write: true,
  annotations: { idempotentHint: false },
  inputSchema: {
    orderId: idSchema.describe("Order UUID"),
    type: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,60}$/, "Use the document type's technical name, e.g. invoice")
      .describe("invoice, delivery_note, credit_note, storno, or another type's technical name"),
    comment: z.string().trim().max(1000).optional().describe("Printed on the document"),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const path = `/api/_action/order/document/${input.type}/create`;
    const body = [
      {
        orderId: input.orderId,
        fileType: "pdf",
        static: false,
        config: input.comment ? { documentComment: input.comment } : {},
      },
    ];
    if (input.dryRun) {
      const dry: DryRunResult = {
        dryRun: true,
        wouldSend: { method: "POST", url: ctx.client.url(path), body },
      };
      return dry;
    }
    const response = await ctx.client.request<CreateResponse>(path, {
      method: "POST",
      body,
      idempotent: false,
    });
    const documentId = str(response.data?.[0]?.documentId);
    if (!documentId) {
      const detail = JSON.stringify(response.errors ?? response).slice(0, 500);
      throw new ShopwareMcpError(422, "DOCUMENT_NOT_CREATED", detail);
    }
    const document = await ctx.client.findById<Raw>("document", documentId, {
      associations: DOCUMENT_ASSOCIATIONS,
      includes: DOCUMENT_INCLUDES,
    });
    return { dryRun: false as const, result: mapDocument(document) };
  },
});

const documentType = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,60}$/, "Use the document type's technical name, e.g. invoice");

export const orderDocumentsBulkCreate = defineTool({
  name: "order_documents_bulk_create",
  title: "Create documents for many orders (guarded)",
  description:
    "Generate one document type for several orders in one request: either the given orderIds, " +
    "or, by default, the paid, not cancelled orders that have no document of that type yet, " +
    "oldest first, up to maxOrders. Closes the 'paid orders without an invoice' audit finding. " +
    "Every order counts as one real write against the write budget, checked before anything " +
    "is sent. dryRun=true (default) lists the orders and the request; to apply, call again " +
    "with the dry run's `apply` arguments (the same orderIds and dryRun: false) so the orders " +
    "invoiced are the ones shown. Returns { dryRun: true, matching, orders[], missing[]?, " +
    "apply, wouldSend } or { dryRun: false, created, documents[], skipped[], errors[], " +
    "orders[], writesLeft? }.",
  write: true,
  selfCharging: true,
  annotations: { idempotentHint: false },
  inputSchema: {
    type: documentType.describe("invoice, delivery_note, credit_note, storno or another type"),
    orderIds: z.array(idSchema).min(1).max(50).optional().describe("Explicit orders"),
    maxOrders: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Cap for the default selection"),
    comment: z.string().trim().max(1000).optional().describe("Printed on every document"),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const filter = input.orderIds
      ? [equalsAny("id", input.orderIds)]
      : [
          equals("transactions.stateMachineState.technicalName", "paid"),
          notCancelled(),
          {
            type: "not" as const,
            operator: "and" as const,
            queries: [equals("documents.documentType.technicalName", input.type)],
          },
        ];
    const found = await ctx.client.search<Raw>("order", {
      page: 1,
      limit: input.orderIds ? input.orderIds.length : input.maxOrders,
      "total-count-mode": 1,
      filter,
      sort: [{ field: "orderDateTime", order: "ASC" }],
      associations: associations([
        "orderCustomer",
        "currency",
        "stateMachineState",
        "transactions.stateMachineState",
        "deliveries.stateMachineState",
      ]),
    });
    const orders = found.items
      .map(mapOrderSummary)
      .filter((order): order is OrderSummary & { id: string } => order.id !== null);
    if (orders.length === 0) throw badRequest(`No orders to create a ${input.type} for`);
    const missing = (input.orderIds ?? []).filter((id) => !orders.some((order) => order.id === id));
    const path = `/api/_action/order/document/${input.type}/create`;
    const body = orders.map((order) => ({
      orderId: order.id,
      fileType: "pdf",
      static: false,
      config: input.comment ? { documentComment: input.comment } : {},
    }));
    if (input.dryRun) {
      const dry: DryRunResult & {
        matching: number;
        orders: typeof orders;
        missing?: string[];
        apply: Record<string, unknown>;
      } = {
        dryRun: true,
        matching: found.total,
        orders,
        ...(missing.length > 0 ? { missing } : {}),
        apply: {
          type: input.type,
          orderIds: orders.map((order) => order.id),
          ...(input.comment ? { comment: input.comment } : {}),
          dryRun: false,
        },
        wouldSend: { method: "POST", url: ctx.client.url(path), body },
      };
      return dry;
    }
    // One real write per order, refused as a whole when the budget cannot take the batch.
    chargeWrites(ctx, orders.length, "order_documents_bulk_create");
    const response = await ctx.client.request<CreateResponse | undefined>(path, {
      method: "POST",
      body,
      idempotent: false,
    });
    const owners = await documentOwners(ctx.client, createdDocumentIds(response));
    const { documents, errors, skipped } = mapBulkResponse(response, orders, owners);
    return {
      dryRun: false as const,
      created: documents.length,
      documents,
      skipped,
      errors,
      orders,
      ...(missing.length > 0 ? { missing } : {}),
      ...(writesLeft(ctx) !== null ? { writesLeft: writesLeft(ctx) } : {}),
    };
  },
});
