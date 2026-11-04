---
"shopware-mcp": minor
---

Ready for Black Friday: check the campaign before it starts, watch the day, see what comes back.

- `promotions_check` looks at every promotion that runs or starts before a date, active or not, and names what would stop it, the way Shopware decides whether a code or an automatic discount applies: still inactive at its start, no discount, no sales channel or only channels in maintenance, a code missing or no unused individual codes left, the redemption limit reached or close, 50 % or more off, a window that ends before it starts, and automatic promotions on the same channel whose discounts add up.
- The audit gained `promotions_broken`: promotions in the next 14 days with a critical finding, so the brief, Slack and the GitHub Action catch a broken campaign too. Eighteen checks now.
- `shopware-mcp watch` looks at orders and payments every few minutes and posts to Slack only when the state gets worse, when the shop stops answering, and when things are back to normal. `--once` with `--state` suits cron.
- `shop_pulse` (and `watch`) can compare with the same weekday around this day last year (`baseline: last-year`) and raise the expectation for a campaign day (`expectFactor`).
- `returns_report` gives the share of orders that came back in full or in part, next to the period before, and ranks products by the share of their orders that came back, from Shopware's own delivery states.
- The audit's e-invoicing duty now checks Shopware itself: ZUGFeRD support (6.7 and later), a document configuration for it, and a VAT ID or tax number in the invoice configuration.
- A `campaign_ready` prompt walks an agent through promotions, the checkout, stock and the plan for the day.
- Tests follow msw 3; dependencies updated.
