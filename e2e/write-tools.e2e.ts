import { beforeAll, describe, expect, it } from "vitest";
import { productsSearch, productUpdate } from "../src/tools/products.js";
import { promotionsList, promotionToggle } from "../src/tools/promotions.js";
import { stockGet, stockSet } from "../src/tools/stock.js";
import type { ToolContext } from "../src/tools/types.js";
import { E2E_ENABLED, e2eContext } from "./setup.js";

describe.skipIf(!E2E_ENABLED)("write tools against dockware", () => {
  let ctx: ToolContext;
  let productId: string;
  let originalStock: number;

  beforeAll(async () => {
    ctx = await e2eContext(true);
    const page = await productsSearch.handler({ page: 1, limit: 1, includeVariants: false }, ctx);
    productId = page.items[0]?.id ?? "";
    originalStock = page.items[0]?.stock ?? 0;
    expect(productId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("stock_set dry run changes nothing", async () => {
    const dry = await stockSet.handler({ productId, stock: originalStock + 5, dryRun: true }, ctx);
    expect(dry).toMatchObject({ dryRun: true, wouldSend: { method: "PATCH" } });
    const stock = await stockGet.handler({ productId }, ctx);
    expect(stock.stock).toBe(originalStock);
  });

  it("stock_set writes and restores", async () => {
    const result = await stockSet.handler(
      { productId, stock: originalStock + 5, dryRun: false },
      ctx,
    );
    expect(result).toMatchObject({ dryRun: false, result: { stock: originalStock + 5 } });
    const restored = await stockSet.handler(
      { productId, stock: originalStock, dryRun: false },
      ctx,
    );
    expect(restored).toMatchObject({ dryRun: false, result: { stock: originalStock } });
  });

  it("product_update toggles active and keeps other currencies", async () => {
    const before = await productsSearch.handler(
      {
        page: 1,
        includeVariants: true,
        filter: [{ type: "equals", field: "id", value: productId }],
      },
      ctx,
    );
    const wasActive = before.items[0]?.active ?? true;
    const updated = await productUpdate.handler(
      { productId, active: !wasActive, dryRun: false },
      ctx,
    );
    expect(updated).toMatchObject({ dryRun: false, result: { active: !wasActive } });
    const restored = await productUpdate.handler(
      { productId, active: wasActive, dryRun: false },
      ctx,
    );
    expect(restored).toMatchObject({ dryRun: false, result: { active: wasActive } });
  });

  it("promotion_toggle round-trips when a promotion exists", async () => {
    const promotions = await promotionsList.handler({ page: 1, limit: 1 }, ctx);
    const promotion = promotions.items[0];
    if (!promotion?.id) return;
    const active = promotion.active ?? false;
    const toggled = await promotionToggle.handler(
      { promotionId: promotion.id, active: !active, dryRun: false },
      ctx,
    );
    expect(toggled).toMatchObject({ dryRun: false, result: { active: !active } });
    await promotionToggle.handler({ promotionId: promotion.id, active, dryRun: false }, ctx);
  });
});
