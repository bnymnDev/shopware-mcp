import { associations, equals, equalsAny, type ShopwareFilter } from "../client/criteria.js";
import type { Raw, ShopwareClient } from "../client/index.js";
import { badRequest } from "../errors.js";
import { isoDate, toIso } from "./periods.js";
import { bool, num, raw, rawList, str, translated } from "./shared.js";
import { defineTool } from "./types.js";

const DAY_MS = 86_400_000;
/** From this share of the global limit on, a promotion may run out during the campaign. */
const LIMIT_SHARE = 0.8;
/** Fewer unused individual codes than this is worth a look before a campaign. */
const FEW_CODES = 20;

export type CheckSeverity = "critical" | "warning" | "info";

export interface PromotionFinding {
  severity: CheckSeverity;
  problem: string;
}

interface Channel {
  id: string;
  name: string | null;
  active: boolean;
  maintenance: boolean;
}

interface CheckedPromotion {
  id: string;
  name: string | null;
  active: boolean;
  validFrom: string | null;
  validUntil: string | null;
  automatic: boolean;
  exclusive: boolean;
  discounted: boolean;
  channelIds: string[];
  findings: PromotionFinding[];
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
const overlaps = (a: CheckedPromotion, b: CheckedPromotion) => {
  const start = (p: CheckedPromotion) => (p.validFrom ? Date.parse(p.validFrom) : -Infinity);
  const end = (p: CheckedPromotion) => (p.validUntil ? Date.parse(p.validUntil) : Infinity);
  return start(a) <= end(b) && start(b) <= end(a);
};

/**
 * Everything a promotion needs to work in a window, checked the way Shopware decides whether a
 * code or an automatic discount applies: active, a channel that serves customers, a discount,
 * a code to redeem, redemptions left.
 */
export async function checkPromotions(
  client: ShopwareClient,
  options: { until: Date; now?: Date },
) {
  const now = options.now ?? new Date();
  const { until } = options;
  if (until.getTime() <= now.getTime()) throw badRequest("`until` must lie in the future");

  // Not over yet and starting before the end of the window, active or not: a campaign that was
  // prepared but never switched on is exactly what this check is for.
  const filter: ShopwareFilter[] = [
    {
      type: "multi",
      operator: "or",
      queries: [
        equals("validUntil", null),
        { type: "range", field: "validUntil", parameters: { gte: now.toISOString() } },
      ],
    },
    {
      type: "multi",
      operator: "or",
      queries: [
        equals("validFrom", null),
        { type: "range", field: "validFrom", parameters: { lte: until.toISOString() } },
      ],
    },
  ];
  const result = await client.search<Raw>("promotion", {
    page: 1,
    limit: 100,
    filter,
    sort: [{ field: "validFrom", order: "ASC" }],
    associations: associations(["salesChannels", "discounts"]),
    includes: {
      promotion: [
        "id",
        "name",
        "translated",
        "active",
        "validFrom",
        "validUntil",
        "useCodes",
        "useIndividualCodes",
        "code",
        "exclusive",
        "maxRedemptionsGlobal",
        "orderCount",
        "salesChannels",
        "discounts",
      ],
      promotion_sales_channel: ["salesChannelId"],
      promotion_discount: ["id", "type", "value", "maxValue", "scope"],
    },
  });
  const promotions = result.items;

  const channelIds = [
    ...new Set(
      promotions.flatMap((promotion) =>
        rawList(promotion.salesChannels)
          .map((entry) => str(entry.salesChannelId))
          .filter((id): id is string => id !== null),
      ),
    ),
  ];
  const individual = promotions
    .filter((promotion) => promotion.useCodes === true && promotion.useIndividualCodes === true)
    .map((promotion) => String(promotion.id));

  const [channelResult, codeResult] = await Promise.all([
    channelIds.length > 0
      ? client.search<Raw>("sales-channel", {
          page: 1,
          limit: channelIds.length,
          filter: [equalsAny("id", channelIds)],
          includes: { sales_channel: ["id", "name", "translated", "active", "maintenance"] },
        })
      : Promise.resolve(null),
    individual.length > 0
      ? client.search<Raw>("promotion-individual-code", {
          page: 1,
          limit: 1,
          "total-count-mode": 0,
          filter: [equalsAny("promotionId", individual), equals("payload", null)],
          includes: { promotion_individual_code: ["id"] },
          aggregations: [
            { name: "unused", type: "terms", field: "promotionId", limit: individual.length },
          ],
        })
      : Promise.resolve(null),
  ]);
  const channels = new Map<string, Channel>(
    (channelResult?.items ?? []).map((channel) => [
      String(channel.id),
      {
        id: String(channel.id),
        name: translated(channel, "name"),
        active: bool(channel.active) ?? false,
        maintenance: bool(channel.maintenance) ?? false,
      },
    ]),
  );
  const unused = new Map<string, number>();
  for (const bucket of rawList(raw(codeResult?.aggregations.unused)?.buckets)) {
    const key = str(bucket.key);
    if (key) unused.set(key, num(bucket.count) ?? 0);
  }

  const soon = now.getTime() + 2 * DAY_MS;
  const checked: CheckedPromotion[] = promotions.map((promotion) => {
    const id = String(promotion.id);
    const active = bool(promotion.active) ?? false;
    const validFrom = str(promotion.validFrom);
    const validUntil = str(promotion.validUntil);
    const useCodes = bool(promotion.useCodes) ?? false;
    const ids = rawList(promotion.salesChannels)
      .map((entry) => str(entry.salesChannelId))
      .filter((value): value is string => value !== null);
    const discounts = rawList(promotion.discounts);
    const findings: PromotionFinding[] = [];
    const add = (severity: CheckSeverity, problem: string) => findings.push({ severity, problem });

    if (!active) {
      const starts = validFrom ? Date.parse(validFrom) : null;
      if (starts !== null && starts > now.getTime()) {
        add(
          starts < soon ? "critical" : "warning",
          `starts on ${day(validFrom)} but is inactive: it will not switch itself on`,
        );
      } else {
        add("info", "inactive");
      }
    }
    if (validFrom && validUntil && Date.parse(validUntil) < Date.parse(validFrom)) {
      add("critical", `ends (${day(validUntil)}) before it starts (${day(validFrom)})`);
    }
    if (validUntil && Date.parse(validUntil) < until.getTime()) {
      add("info", `ends on ${day(validUntil)}, before the end of the window`);
    }
    if (discounts.length === 0) {
      add("critical", "has no discount: Shopware refuses it, customers get nothing");
    }
    for (const discount of discounts) {
      const value = num(discount.value) ?? 0;
      if (str(discount.type) === "percentage" && value >= 100) {
        add("critical", `gives ${value} % off: the cart becomes free`);
      } else if (str(discount.type) === "percentage" && value >= 50) {
        add(
          "warning",
          `gives ${value} % off${num(discount.maxValue) ? "" : " without a cap"}: unusually high, worth a second look`,
        );
      }
    }
    if (ids.length === 0) {
      add("critical", "is assigned to no sales channel: it applies nowhere");
    } else {
      const serving = ids
        .map((channelId) => channels.get(channelId))
        .filter((channel): channel is Channel => channel !== undefined)
        .filter((channel) => channel.active && !channel.maintenance);
      if (serving.length === 0) {
        const names = ids.map((channelId) => channels.get(channelId)?.name ?? channelId);
        add(
          "critical",
          `runs only in ${names.join(", ")}, which ${names.length === 1 ? "is" : "are"} inactive or in maintenance`,
        );
      }
    }
    if (useCodes) {
      if (bool(promotion.useIndividualCodes)) {
        const left = unused.get(id) ?? 0;
        if (left === 0) add("critical", "uses individual codes, but none is left unused");
        else if (left < FEW_CODES) add("warning", `only ${left} unused individual codes left`);
      } else if (!str(promotion.code)) {
        add("critical", "needs a code but has none, so nobody can redeem it");
      }
    }
    const limit = num(promotion.maxRedemptionsGlobal) ?? 0;
    const used = num(promotion.orderCount) ?? 0;
    if (limit > 0 && used >= limit) {
      add("critical", `has used all ${limit} redemptions`);
    } else if (limit > 0 && used >= LIMIT_SHARE * limit) {
      add(
        "warning",
        `has used ${used} of ${limit} redemptions; it may run out during the campaign`,
      );
    }
    return {
      id,
      name: translated(promotion, "name"),
      active,
      validFrom,
      validUntil,
      automatic: !useCodes,
      exclusive: bool(promotion.exclusive) ?? false,
      discounted: discounts.length > 0,
      channelIds: ids,
      findings,
    };
  });

  // Automatic promotions add up unless one is exclusive: two of them on the same channel at the
  // same time give every customer both discounts.
  const automatic = checked.filter(
    (promotion) => promotion.active && promotion.automatic && promotion.discounted,
  );
  for (const promotion of automatic) {
    const others = automatic.filter(
      (other) =>
        other !== promotion &&
        !promotion.exclusive &&
        !other.exclusive &&
        overlaps(promotion, other) &&
        other.channelIds.some((channelId) => promotion.channelIds.includes(channelId)),
    );
    if (others.length > 0) {
      promotion.findings.push({
        severity: "warning",
        problem: `applies automatically together with ${others.map((other) => `"${other.name}"`).join(", ")}: the discounts add up`,
      });
    }
  }

  const order: Record<CheckSeverity, number> = { critical: 0, warning: 1, info: 2 };
  for (const promotion of checked) {
    promotion.findings.sort((a, b) => order[a.severity] - order[b.severity]);
  }
  const all = checked.flatMap((promotion) => promotion.findings);
  const count = (severity: CheckSeverity) =>
    all.filter((finding) => finding.severity === severity).length;
  const worst = (promotion: CheckedPromotion) =>
    Math.min(3, ...promotion.findings.map((finding) => order[finding.severity]));
  return {
    window: { from: now.toISOString(), until: until.toISOString() },
    checked: checked.length,
    complete: result.total <= checked.length,
    summary: {
      critical: count("critical"),
      warning: count("warning"),
      info: count("info"),
      ready: checked.filter((promotion) => worst(promotion) >= 2 && promotion.active).length,
    },
    promotions: checked
      .sort((a, b) => worst(a) - worst(b))
      .map(
        ({ channelIds, automatic: isAutomatic, exclusive: _e, discounted: _d, ...promotion }) => ({
          ...promotion,
          kind: isAutomatic ? ("automatic" as const) : ("code" as const),
          salesChannels: channelIds.map((channelId) => channels.get(channelId)?.name ?? channelId),
        }),
      ),
  };
}

export const promotionsCheck = defineTool({
  name: "promotions_check",
  title: "Check promotions before a campaign",
  description:
    "Before Black Friday or any sale: check every promotion that runs or starts before a date, " +
    "active or not, the way Shopware decides whether it applies. Flags a promotion that starts " +
    "but is still inactive, has no discount, no sales channel or only channels in maintenance, " +
    "needs a code but has none, has no unused individual codes left, is close to its redemption " +
    "limit, gives 50 % or more, ends before it starts, or applies automatically together with " +
    "another one so the discounts add up. Read-only. Returns { window, checked, summary, " +
    "promotions[] } with findings per promotion, worst first.",
  inputSchema: {
    until: isoDate
      .optional()
      .describe(
        "End of the campaign window, ISO date (a date covers the whole day). Default: in 14 days",
      ),
  },
  handler: async (input, ctx) => {
    const now = new Date();
    const until = new Date(toIso(input.until, new Date(now.getTime() + 14 * DAY_MS), true));
    return checkPromotions(ctx.client, { until, now });
  },
});
