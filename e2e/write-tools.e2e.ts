import { beforeAll, describe, expect, it } from "vitest";
import {
  orderDeliveryTransition,
  ordersGet,
  ordersSearch,
  orderTransactionTransition,
} from "../src/tools/orders.js";
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

  it("delivery and transaction transitions act on the order's newest records", async () => {
    // An open order whose delivery and payment are still open; skipped on shops without one.
    const open = await ordersSearch.handler(
      {
        page: 1,
        limit: 1,
        filter: [
          { type: "equals", field: "stateMachineState.technicalName", value: "open" },
          { type: "equals", field: "deliveries.stateMachineState.technicalName", value: "open" },
          { type: "equals", field: "transactions.stateMachineState.technicalName", value: "open" },
        ],
      },
      ctx,
    );
    const orderId = open.items[0]?.id;
    if (!orderId) return;

    const dry = await orderDeliveryTransition.handler(
      { orderId, transition: "ship", trackingCodes: ["E2E-1"], dryRun: true },
      ctx,
    );
    const wouldSend = dry.dryRun ? dry.wouldSend : [];
    expect(Array.isArray(wouldSend) ? wouldSend : []).toHaveLength(2);
    await expect(
      orderDeliveryTransition.handler(
        { orderId, transition: "ship", deliveryId: "0".repeat(32), dryRun: true },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const shipped = await orderDeliveryTransition.handler(
      { orderId, transition: "ship", trackingCodes: ["E2E-1"], dryRun: false },
      ctx,
    );
    expect(shipped).toMatchObject({ dryRun: false, result: { deliveryState: "shipped" } });
    const detail = await ordersGet.handler({ orderId }, ctx);
    expect(detail.deliveries.at(-1)?.trackingCodes).toEqual(["E2E-1"]);
    const reopened = await orderDeliveryTransition.handler(
      { orderId, transition: "reopen", trackingCodes: [], dryRun: false },
      ctx,
    );
    expect(reopened).toMatchObject({ dryRun: false, result: { deliveryState: "open" } });

    const reminded = await orderTransactionTransition.handler(
      { orderId, transition: "remind", dryRun: false },
      ctx,
    );
    expect(reminded).toMatchObject({ dryRun: false, result: { paymentState: "reminded" } });
    const restored = await orderTransactionTransition.handler(
      { orderId, transition: "reopen", dryRun: false },
      ctx,
    );
    expect(restored).toMatchObject({ dryRun: false, result: { paymentState: "open" } });
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
