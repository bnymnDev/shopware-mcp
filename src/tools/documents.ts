import { z } from "zod";
import { associations, equals } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest, ShopwareMcpError } from "../errors.js";
import { bool, dryRunField, idSchema, raw, str } from "./shared.js";
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
  errors?: unknown;
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
