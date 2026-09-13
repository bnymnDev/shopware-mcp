import { z } from "zod";
import { associations, equalsAny } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { dryRunField, idSchema, newId, rawList, str } from "./shared.js";
import { type DryRunResult, defineTool, type WouldSend } from "./types.js";

const TAGGABLE = ["customer", "order", "product"] as const;
type Taggable = (typeof TAGGABLE)[number];

const tagName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\p{Cc}]+$/u, "No control characters");

/** Shopware compares tag names case-insensitively (utf8mb4_unicode_ci), so this does too. */
const fold = (name: string) => name.toLocaleLowerCase("en");

/** First spelling wins; duplicates that differ only in case are dropped. */
function unique(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = fold(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function tagsOf(client: ShopwareClient, entity: Taggable, id: string) {
  const record = await client.findById<Raw>(entity, id, {
    associations: associations(["tags"]),
    includes: { [entity]: ["id", "tags"], tag: ["id", "name"] },
  });
  return rawList(record.tags)
    .map((tag) => ({ id: str(tag.id), name: str(tag.name) }))
    .filter((tag): tag is { id: string; name: string } => tag.id !== null && tag.name !== null);
}

export const tagAssign = defineTool({
  name: "tag_assign",
  title: "Assign tags (guarded)",
  description:
    "Add tags to or remove tags from one customer, order or product, by tag name. Names match " +
    "the shop's tags regardless of case; tags that do not exist yet are created in the same " +
    "request; other tags on the record stay. Shopware's rules, flows and admin filters work " +
    "with tags, so 'mark this customer as VIP' or 'flag this order for review' becomes a tag. " +
    "dryRun=true (default) returns the requests without changing anything; call again with " +
    "dryRun=false to apply. Counts as one write. Returns { dryRun: true, wouldSend[], " +
    "unchanged } or { dryRun: false, result: { entity, id, tags[] } }.",
  write: true,
  inputSchema: {
    entity: z.enum(TAGGABLE),
    id: idSchema.describe("UUID of the customer, order or product"),
    add: z.array(tagName).max(20).optional().describe("Tag names to add"),
    remove: z.array(tagName).max(20).optional().describe("Tag names to remove"),
    dryRun: dryRunField,
  },
  handler: async (input, ctx) => {
    const add = unique(input.add ?? []);
    const remove = unique(input.remove ?? []);
    if (add.length === 0 && remove.length === 0) throw badRequest("Provide add and/or remove");
    const removing = new Set(remove.map(fold));
    const overlap = add.filter((name) => removing.has(fold(name)));
    if (overlap.length > 0) throw badRequest(`Cannot add and remove ${overlap.join(", ")}`);

    const current = await tagsOf(ctx.client, input.entity, input.id);
    const onRecord = (name: string) => current.find((tag) => fold(tag.name) === fold(name));
    const toAdd = add.filter((name) => !onRecord(name));
    const byKey = new Map<string, { id: string; name: string }>();
    if (toAdd.length > 0) {
      const existing = await ctx.client.search<Raw>("tag", {
        page: 1,
        limit: 50,
        filter: [equalsAny("name", toAdd)],
        includes: { tag: ["id", "name"] },
      });
      for (const tag of existing.items) {
        const id = str(tag.id);
        const name = str(tag.name);
        if (!id || !name) continue;
        const key = fold(name);
        // An exact spelling beats a tag that only matches case-insensitively.
        if (!byKey.has(key) || toAdd.includes(name)) byKey.set(key, { id, name });
      }
    }

    const requests: WouldSend[] = [];
    const runs: (() => Promise<unknown>)[] = [];
    const assign = toAdd.map((name) => {
      const known = byKey.get(fold(name));
      return known ? { id: known.id } : { id: newId(), name };
    });
    if (assign.length > 0) {
      const path = `/api/${input.entity}/${input.id}`;
      const body = { tags: assign };
      requests.push({ method: "PATCH", url: ctx.client.url(path), body });
      runs.push(() => ctx.client.request(path, { method: "PATCH", body }));
    }
    for (const name of remove) {
      const tag = onRecord(name);
      if (!tag) continue;
      const path = `/api/${input.entity}/${input.id}/tags/${tag.id}`;
      requests.push({ method: "DELETE", url: ctx.client.url(path), body: null });
      runs.push(() => ctx.client.request(path, { method: "DELETE" }));
    }
    if (input.dryRun) {
      const dry: DryRunResult & { unchanged: boolean } = {
        dryRun: true,
        wouldSend: requests,
        unchanged: requests.length === 0,
      };
      return dry;
    }
    for (const run of runs) await run();
    const tags = await tagsOf(ctx.client, input.entity, input.id);
    return { dryRun: false as const, result: { entity: input.entity, id: input.id, tags } };
  },
});
