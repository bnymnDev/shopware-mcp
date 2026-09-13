import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { froshComposerAudit, froshHealth, froshQueue } from "../src/extensions/frosh.js";
import { detectExtensionTools } from "../src/extensions/index.js";
import { productCoverSet } from "../src/tools/media.js";
import { shopSettings } from "../src/tools/settings.js";
import type { WouldSend } from "../src/tools/types.js";
import {
  createContext,
  fixture,
  invoke,
  mock,
  requests,
  SHOP_URL,
  searchHandler,
  writeRequests,
} from "./helpers/shopware.js";

const ctx = createContext({ allowWrite: true });
type Body = Record<string, unknown>;
type Rows = { data: Array<Record<string, unknown>> };
const HEX = /^[0-9a-f]{32}$/;
const PRODUCT = (fixture<Rows>("products-search").data[0] as { id: string }).id;
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The request list of a dry run; fails loudly on a real write. */
function stepsOf(result: unknown): WouldSend[] {
  const dry = result as { dryRun?: boolean; wouldSend?: WouldSend | WouldSend[] };
  if (dry.dryRun !== true || !Array.isArray(dry.wouldSend)) throw new Error("expected a dry run");
  return dry.wouldSend;
}

describe("product_cover_set", () => {
  it("plans media, upload from URL, product media and cover in the product folder", async () => {
    const dry = await invoke(
      productCoverSet,
      {
        productId: PRODUCT,
        imageUrl: "https://cdn.example.com/photos/Bench%20front.JPG",
        alt: "Bench",
      },
      ctx,
    );
    const steps = stepsOf(dry);
    expect(steps.map((step) => `${step.method} ${step.url}`)).toEqual([
      "POST https://shop.test/api/media",
      expect.stringMatching(
        /^POST https:\/\/shop\.test\/api\/_action\/media\/[0-9a-f]{32}\/upload\?extension=jpg&fileName=sw10001-[0-9a-f]{8}$/,
      ),
      "POST https://shop.test/api/product-media",
      `PATCH https://shop.test/api/product/${PRODUCT}`,
    ]);
    const [media, upload, productMedia, cover] = steps.map((step) => step.body as Body);
    expect(media).toMatchObject({
      mediaFolderId: "01a068fb6a2a733b86a9a409f7e3aba3",
      alt: "Bench",
    });
    expect(media?.id).toMatch(HEX);
    expect(upload).toEqual({ url: "https://cdn.example.com/photos/Bench%20front.JPG" });
    expect(productMedia).toMatchObject({ productId: PRODUCT, mediaId: media?.id, position: 0 });
    expect(cover).toEqual({ coverId: productMedia?.id });
    expect(writeRequests()).toHaveLength(0);
  });

  it("uploads base64 bytes with the image content type and reads the product back", async () => {
    const applied = await invoke(
      productCoverSet,
      {
        productId: PRODUCT,
        imageBase64: PNG,
        mimeType: "image/png",
        fileName: "Front view",
        dryRun: false,
      },
      ctx,
    );
    const sent = writeRequests();
    expect(sent.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual([
      "POST /api/media",
      expect.stringMatching(/^POST \/api\/_action\/media\/[0-9a-f]{32}\/upload$/),
      "POST /api/product-media",
      `PATCH /api/product/${PRODUCT}`,
    ]);
    const upload = sent[1];
    expect(upload?.path).toMatch(/extension=png&fileName=front-view-[0-9a-f]{8}$/);
    expect(upload?.headers["content-type"]).toBe("image/png");
    expect(String(upload?.body)).toContain("PNG");
    expect(applied).toMatchObject({ dryRun: false, result: { id: expect.any(String) } });
  });

  it("validates the image source", async () => {
    await expect(invoke(productCoverSet, { productId: PRODUCT }, ctx)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      invoke(productCoverSet, { productId: PRODUCT, imageUrl: "https://x.test/file.svg" }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      invoke(productCoverSet, { productId: PRODUCT, imageUrl: "ftp://x.test/file.png" }, ctx),
    ).rejects.toThrow(/http/);
    await expect(
      invoke(productCoverSet, { productId: PRODUCT, imageBase64: PNG }, ctx),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", detail: expect.stringContaining("mimeType") });
    await expect(
      invoke(
        productCoverSet,
        { productId: PRODUCT, imageBase64: "%%%", mimeType: "image/png" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("shop_settings", () => {
  it("reads the chosen domains, shortens keys and drops credential-like ones", async () => {
    const paths: string[] = [];
    mock.use(
      http.get(`${SHOP_URL}/api/_action/system-config`, ({ request }) => {
        const url = new URL(request.url);
        paths.push(url.pathname + url.search);
        const domain = url.searchParams.get("domain");
        return HttpResponse.json({
          [`${domain}.passwordMinLength`]: 8,
          [`${domain}.guestCheckout`]: true,
          [`${domain}.apiToken`]: "must-not-leak",
          [`${domain}.smtpPassword`]: "nor-this",
        });
      }),
    );
    const result = await invoke(
      shopSettings,
      { domains: ["core.loginRegistration", "core.cart"], salesChannelId: PRODUCT },
      ctx,
    );
    expect(result).toEqual({
      salesChannelId: PRODUCT,
      inherited: true,
      settings: {
        "core.loginRegistration": { passwordMinLength: 8, guestCheckout: true },
        "core.cart": { passwordMinLength: 8, guestCheckout: true },
      },
    });
    expect(paths).toEqual([
      `/api/_action/system-config?domain=core.loginRegistration&salesChannelId=${PRODUCT}&inherit=1`,
      `/api/_action/system-config?domain=core.cart&salesChannelId=${PRODUCT}&inherit=1`,
    ]);
    expect(JSON.stringify(result)).not.toContain("leak");
  });

  it("defaults to the trading domains shop-wide", async () => {
    const result = await invoke(shopSettings, {}, ctx);
    expect(Object.keys(result.settings)).toEqual([
      "core.basicInformation",
      "core.loginRegistration",
      "core.cart",
      "core.listing",
    ]);
    expect(result.inherited).toBe(false);
  });
});

describe("FroshTools pack", () => {
  it("is detected only when the plugin is active", async () => {
    expect((await detectExtensionTools(createContext())).map((t) => t.tool.name)).not.toContain(
      "frosh_health",
    );
    mock.use(searchHandler({ plugin: "frosh-plugins" }));
    const detected = await detectExtensionTools(createContext({ extensions: true }));
    expect(detected.filter((t) => t.packId === "frosh").map((t) => t.tool.name)).toEqual([
      "frosh_health",
      "frosh_queue",
      "frosh_composer_audit",
    ]);
  });

  it("maps health and performance checks and filters by state", async () => {
    const all = await invoke(froshHealth, {}, ctx);
    const states = [
      ...(fixture<Array<{ state: string }>>("frosh-health") ?? []),
      ...(fixture<Array<{ state: string }>>("frosh-performance") ?? []),
    ].map((check) => check.state);
    expect(all.summary).toEqual({
      ok: states.filter((s) => s === "STATE_OK").length,
      info: states.filter((s) => s === "STATE_INFO").length,
      warning: states.filter((s) => s === "STATE_WARNING").length,
      error: states.filter((s) => s === "STATE_ERROR").length,
    });
    expect(all.checks).toHaveLength(states.length);
    expect(all.summary.error).toBeGreaterThan(0);
    expect(all.checks[0]).toEqual({
      id: "php-memory-limit",
      category: "health",
      label: "Memory-Limit",
      state: "error",
      current: "0",
      recommended: "min 512M",
    });
    const bad = await invoke(froshHealth, { state: ["error"], includePerformance: false }, ctx);
    expect(bad.checks.map((c) => c.id)).toEqual(["php-memory-limit"]);
    expect(bad.summary.warning).toBeLessThan(all.summary.warning);
    expect(requests.filter((r) => r.path.includes("performance"))).toHaveLength(1);
  });

  it("maps queue transports and messages", async () => {
    const queue = await invoke(froshQueue, {}, ctx);
    expect(queue.transports[0]).toEqual({
      name: "async",
      type: "Doctrine",
      size: 122,
      oldestMessageAgeSeconds: expect.any(Number),
      workerLastSeenSeconds: null,
      browsable: true,
    });
    expect(queue.messages[1]).toEqual({
      name: "Shopware\\Core\\Content\\Media\\Message\\GenerateThumbnailsMessage",
      size: 69,
    });
  });

  it("maps the composer audit", async () => {
    const audit = await invoke(froshComposerAudit, {}, ctx);
    const cachedAt = fixture<{ cachedAt: number }>("frosh-composer-audit").cachedAt;
    expect(audit).toEqual({
      packages: 201,
      vulnerable: 0,
      advisories: [],
      cachedAt: new Date(cachedAt * 1000).toISOString(),
    });
  });
});
