import { ShopwareMcpError } from "./errors.js";
import { logger } from "./logger.js";
import type { ToolContext } from "./tools/types.js";

/** Real writes performed per process, for the optional SHOPWARE_MCP_MAX_WRITES cap. */
const writesUsed = new WeakMap<ToolContext, number>();

/**
 * Count `count` real writes against the cap, or refuse them all. Dry runs never call this.
 * The server charges one per real tool call; bulk tools charge one per record on top.
 */
export function chargeWrites(ctx: ToolContext, count: number, tool: string): void {
  const cap = ctx.config.maxWrites;
  if (cap <= 0 || count <= 0) return;
  const used = writesUsed.get(ctx) ?? 0;
  if (used + count > cap) {
    throw new ShopwareMcpError(
      403,
      "WRITE_BUDGET_EXHAUSTED",
      `This process has used ${used} of its ${cap} real writes (SHOPWARE_MCP_MAX_WRITES) and ` +
        `${count} more would exceed the cap; restart it or raise the cap`,
    );
  }
  writesUsed.set(ctx, used + count);
  if (used + count === cap) logger.warn("write budget exhausted", { tool, cap });
}

/** Writes still allowed in this process, or null when there is no cap. */
export function writesLeft(ctx: ToolContext): number | null {
  const cap = ctx.config.maxWrites;
  if (cap <= 0) return null;
  return Math.max(0, cap - (writesUsed.get(ctx) ?? 0));
}
