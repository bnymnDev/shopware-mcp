import type { AuditRule } from "./rules.js";

/**
 * Ready-made audit rules for duties that touch product data. Each is a plain Shopware filter,
 * the same as a shop's own rules, so what they check can be read in one line. They flag what
 * is missing in the data; whether a shop is compliant is a question for a lawyer.
 */
const ACTIVE = { type: "equals", field: "active", value: true };

export const RULE_PACKS = {
  /** EU General Product Safety Regulation, since 13 December 2024. */
  gpsr: [
    {
      id: "gpsr_products_without_manufacturer",
      title: "GPSR: active products without a manufacturer",
      severity: "warning",
      entity: "product",
      filter: [ACTIVE, { type: "equals", field: "manufacturerId", value: null }],
      hint:
        "The GPSR asks for the manufacturer's name and postal and electronic address on every " +
        "product offered online. Assign a manufacturer to these products.",
    },
    {
      id: "gpsr_manufacturers_without_contact",
      title: "GPSR: manufacturers of active products without a contact link",
      severity: "warning",
      entity: "product_manufacturer",
      filter: [
        { type: "equals", field: "products.active", value: true },
        { type: "equals", field: "link", value: null },
      ],
      hint:
        "Shopware's core keeps no manufacturer address. Put the electronic address in the " +
        "link and the postal address in the description, or use a GPSR extension; products " +
        "made outside the EU also need the EU responsible person.",
    },
  ],
  /** European Accessibility Act, for shops since 28 June 2025. */
  eaa: [
    {
      id: "eaa_product_images_without_alt",
      title: "Accessibility: product images without alt text",
      severity: "warning",
      entity: "product_media",
      filter: [{ type: "equals", field: "media.alt", value: null }],
      hint:
        "Screen readers read the alt text instead of the picture; without it a blind customer " +
        "hears a file name. Add a short description in the media manager.",
    },
    {
      id: "eaa_products_without_description",
      title: "Accessibility: active products without a description",
      severity: "info",
      entity: "product",
      filter: [ACTIVE, { type: "equals", field: "description", value: null }],
      hint: "A product page needs text that says what the product is, not only pictures.",
    },
  ],
  /** What shopping feeds, marketplaces and AI shopping agents need to list a product. */
  feeds: [
    {
      id: "feed_products_without_gtin",
      title: "Feeds: active products without a GTIN (EAN)",
      severity: "info",
      entity: "product",
      filter: [ACTIVE, { type: "equals", field: "ean", value: null }],
      hint:
        "Google Shopping, marketplaces and AI shopping agents match products by GTIN; without " +
        "one a product is shown less or rejected.",
    },
    {
      id: "feed_products_without_mpn",
      title: "Feeds: active products without a manufacturer number",
      severity: "info",
      entity: "product",
      filter: [ACTIVE, { type: "equals", field: "manufacturerNumber", value: null }],
      hint: "Without a GTIN, feeds identify a product by brand plus manufacturer number (MPN).",
    },
    {
      id: "feed_products_without_weight",
      title: "Feeds: active products without a weight",
      severity: "info",
      entity: "product",
      filter: [ACTIVE, { type: "equals", field: "weight", value: null }],
      hint: "Feeds and agents compute shipping costs from the weight.",
    },
  ],
} satisfies Record<string, AuditRule[]>;

export type RulePack = keyof typeof RULE_PACKS;
export const RULE_PACK_NAMES = Object.keys(RULE_PACKS) as RulePack[];

export const isRulePack = (value: string): value is RulePack =>
  (RULE_PACK_NAMES as string[]).includes(value);

export function rulesOfPacks(packs: readonly string[]): AuditRule[] {
  return packs.flatMap((pack): AuditRule[] => (isRulePack(pack) ? RULE_PACKS[pack] : []));
}
