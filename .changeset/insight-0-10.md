---
"shopware-mcp": minor
---

Synthetic customers, an alarm that says why, and what a discount costs.

- `journeys_run` walks fixed buying paths through the real cart and names the expectation each one broke; `watch --journeys <file>` runs them on every look.
- `shop_diagnose` looks at the usual suspects when orders stop: maintenance mode, a test purchase of the best seller, extensions changed in the last day, errors in Shopware's log, stopped scheduled tasks. The watch attaches it to its alarm (`--no-diagnose` to leave it out).
- `promotion_impact` replays a discount or an existing promotion on the real orders of the last weeks; `margin_check` finds products sold below cost and thin margins after the running discount.
- `shop_audit` runs the shop's own rules, Shopware filters in a JSON file (`--rules`, `SHOPWARE_MCP_RULES`).
- `shop_pulse` leaves public holidays (DE, AT, CH) out of "usual", picked by the time zone.
- `brief --history <file>` keeps a health score per day and shows the trend in Markdown, HTML and Slack.
