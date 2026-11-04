---
name: shopware-shop-manager
description: Run a Shopware 6 shop with an assistant - the morning check, "why are there no orders?", campaign preparation, EU product-data duties and readiness for AI shopping agents - through the shopware-mcp server. Use when someone asks how their Shopware shop is doing, why sales stopped, whether a promotion will work, or what to fix before Black Friday, a Shopware update or the GPSR.
---

# Shopware shop manager

This skill works through the tools of **shopware-mcp**, an MCP server for the Shopware 6 Admin API.
If its tools (`shop_brief`, `shop_audit`, ...) are not available, tell the person how to add them and
stop:

- Nothing to install: add `https://p-h07rka.project.space/mcp` as a connector; it asks for the shop's
  address and an Integration's keys once. Read-only.
- Local: `npx -y shopware-mcp` with `SHOPWARE_URL`, `SHOPWARE_CLIENT_ID`, `SHOPWARE_CLIENT_SECRET`;
  `npx shopware-mcp setup --url https://their-shop` creates a least-privilege Integration.

Answer in the person's language, lead with the one thing that matters most, and give numbers with
what they are compared against. Never invent figures: every number comes from a tool result.

## The morning check: "How is the shop doing?"

1. `shop_brief` - orders and revenue so far against the same hours of recent weeks, the audit's
   findings, the last seven days.
2. If the headline is not "as usual", go to the matching section below.
3. Close with at most three actions, most urgent first, each with the tool or admin page that does it.

## "Why are there no orders?"

1. `shop_pulse` - is the quiet spell unusual for this hour and weekday? If the verdict is `normal`,
   say so and stop: small shops are often quiet.
2. `shop_diagnose` - maintenance mode, a test purchase of the best seller, extensions changed in the
   last day, errors in Shopware's log, a stopped worker.
3. `checkout_simulate` with the best seller and the country the person sells to most, to confirm.
4. Name the most likely cause and how sure the evidence is. If nothing explains it, say which
   payment provider status page and log to check next.

## Before a campaign

1. `promotions_check` with the campaign's end date: inactive at start, no codes left, 60 % that was
   meant to be 6 %, automatic discounts that add up.
2. `promotion_impact` with the planned discount: what it would have cost on last month's orders.
3. `margin_check`: products that the discount pushes below cost.
4. `stock_forecast` for the best sellers over the campaign's days.
5. Suggest `shopware-mcp watch --baseline last-year --expect 3 --slack <webhook>` for the day itself.

## EU duties in the product data

`shop_audit` with `rulePacks: ["gpsr", "eaa", "feeds"]`: manufacturer data for the GPSR, alt texts and
descriptions for the European Accessibility Act, GTINs and weights for shopping feeds. Say clearly that
this checks data, not legal compliance.

## Ready for AI shopping agents

`agent_readiness`: which products ChatGPT, Gemini and other agents can list, what keeps the rest out,
and whether the pages an agent checkout links to exist. Offer `shopware-mcp feed --out feed.jsonl`
for the full feed.

## Before a Shopware update

`update_check`: the next version, the security issues it fixes, and per extension whether it works
with it. Blockers first; extensions not in the store need a test on a staging copy.

## Changing things

Only if the server runs with write access. Every write tool defaults to a dry run: show the person
what would be sent, and only repeat it with `dryRun: false` after they agreed.
