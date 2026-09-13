import { z } from "zod";
import { associations, equals } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { fetchProductDetail } from "./products.js";
import { dryRunField, idSchema, newId, rawList, str } from "./shared.js";
import { type DryRunResult, defineTool, type WouldSend } from "./types.js";

/** Image types Shopware renders as product pictures; SVG is left out on purpose (scripts). */
const EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif"] as const;
type Extension = (typeof EXTENSIONS)[number];

const MIME_TO_EXTENSION: Record<string, Extension> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** 8 MB of image is plenty for a product picture and keeps a tool call within reason. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function extensionFromUrl(url: string): Extension | null {
  const path = new URL(url).pathname.toLowerCase();
  const match = /\.([a-z0-9]+)$/.exec(path);
  const candidate = match?.[1] === "jpeg" ? "jpg" : match?.[1];
  return EXTENSIONS.includes(candidate as Extension) ? (candidate as Extension) : null;
}

const safeFileName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "product-image";

/** Shopware's default folder for product pictures, so uploads land where the admin expects them. */
async function productMediaFolderId(client: ShopwareClient): Promise<string | null> {
  const result = await client.search<Raw>("media-folder", {
    page: 1,
    limit: 1,
    filter: [equals("defaultFolder.entity", "product")],
    associations: associations(["defaultFolder"]),
    includes: { media_folder: ["id"] },
  });
  return str(result.items[0]?.id);
}

export const productCoverSet = defineTool({
  name: "product_cover_set",
  title: "Set product cover image (guarded)",
  description:
    "Give a product a cover image from a public image URL (the shop downloads it) or from " +
    "base64-encoded image bytes: the media record is created in the product media folder, " +
    "the file uploaded, attached to the product and set as its cover. Existing pictures stay. " +
    "Closes the 'products without cover image' audit finding. dryRun=true (default) returns " +
    "the four requests without changing anything; call again with dryRun=false to apply. " +
    "Returns { dryRun, wouldSend[] } or { dryRun: false, result: <updated product> }.",
  write: true,
  annotations: { idempotentHint: false },
  inputSchema: {
    productId: idSchema.describe("Product UUID"),
    imageUrl: z
      .string()
      .url()
      .max(2000)
      .refine((url) => /^https?:\/\//i.test(url), "http(s) URLs only")
      .optional()
      .describe("Public image URL ending in .jpg, .png, .webp, .gif or .avif"),
    imageBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
      .optional()
      .describe("Image bytes as base64 (max 8 MB); needs mimeType"),
    mimeType: z
      .enum(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"])
      .optional()
      .describe("Type of the base64 image"),
    fileName: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("File name without extension; defaults to the product number"),
    alt: z.string().max(255).optional().describe("Alt text of the image"),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    if ((input.imageUrl === undefined) === (input.imageBase64 === undefined)) {
      throw badRequest("Provide exactly one of: imageUrl, imageBase64");
    }
    let extension: Extension;
    let bytes: Uint8Array | undefined;
    if (input.imageUrl !== undefined) {
      const fromUrl = extensionFromUrl(input.imageUrl);
      if (!fromUrl) throw badRequest("imageUrl must end in .jpg, .png, .webp, .gif or .avif");
      extension = fromUrl;
    } else {
      if (!input.mimeType) throw badRequest("mimeType is required with imageBase64");
      extension = MIME_TO_EXTENSION[input.mimeType] ?? "jpg";
      bytes = new Uint8Array(Buffer.from(input.imageBase64 ?? "", "base64"));
      if (bytes.length === 0) throw badRequest("imageBase64 is not valid base64");
      if (bytes.length > MAX_IMAGE_BYTES) throw badRequest("Image is larger than 8 MB");
    }

    const [product, folderId] = await Promise.all([
      ctx.client.findById<Raw>("product", input.productId, {
        associations: associations(["media"]),
        includes: { product: ["id", "productNumber", "media"], product_media: ["id", "position"] },
      }),
      productMediaFolderId(ctx.client),
    ]);
    const position = rawList(product.media).length;
    const fileName = safeFileName(input.fileName ?? str(product.productNumber) ?? "product-image");
    const mediaId = newId();
    const productMediaId = newId();
    const uploadPath =
      `/api/_action/media/${mediaId}/upload?extension=${extension}` +
      `&fileName=${encodeURIComponent(`${fileName}-${mediaId.slice(0, 8)}`)}`;

    const mediaBody: Raw = { id: mediaId, ...(folderId ? { mediaFolderId: folderId } : {}) };
    if (input.alt !== undefined) mediaBody.alt = input.alt;
    const steps: { request: WouldSend; run: () => Promise<unknown> }[] = [
      {
        request: { method: "POST", url: ctx.client.url("/api/media"), body: mediaBody },
        run: () =>
          ctx.client.request("/api/media", { method: "POST", body: mediaBody, idempotent: false }),
      },
      {
        request: {
          method: "POST",
          url: ctx.client.url(uploadPath),
          body: input.imageUrl !== undefined ? { url: input.imageUrl } : { bytes: bytes?.length },
        },
        run: () =>
          input.imageUrl !== undefined
            ? ctx.client.request(uploadPath, {
                method: "POST",
                body: { url: input.imageUrl },
                idempotent: false,
              })
            : ctx.client.request(uploadPath, {
                method: "POST",
                rawBody: bytes,
                headers: { "content-type": input.mimeType ?? "application/octet-stream" },
                idempotent: false,
              }),
      },
      {
        request: {
          method: "POST",
          url: ctx.client.url("/api/product-media"),
          body: { id: productMediaId, productId: input.productId, mediaId, position },
        },
        run: () =>
          ctx.client.request("/api/product-media", {
            method: "POST",
            body: { id: productMediaId, productId: input.productId, mediaId, position },
            idempotent: false,
          }),
      },
      {
        request: {
          method: "PATCH",
          url: ctx.client.url(`/api/product/${input.productId}`),
          body: { coverId: productMediaId },
        },
        run: () =>
          ctx.client.request(`/api/product/${input.productId}`, {
            method: "PATCH",
            body: { coverId: productMediaId },
          }),
      },
    ];
    if (input.dryRun) {
      const dry: DryRunResult = { dryRun: true, wouldSend: steps.map((step) => step.request) };
      return dry;
    }
    for (const step of steps) await step.run();
    return { dryRun: false, result: await fetchProductDetail(ctx.client, input.productId) };
  },
});
