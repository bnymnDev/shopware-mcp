---
"shopware-mcp": minor
---

See the shop the way a customer does, notice when orders stop, and set everything up with the least rights it needs.

- `checkout_simulate` fills a throwaway cart through Shopware's admin proxy to the Store API, as a guest with a shipping country or logged in as a customer, and returns what Shopware calculates: prices per item next to the listing price, discounts, shipping, taxes, the total, the payment and shipping methods offered and the ones hidden with the rule behind them, and every cart error with a plain explanation (a country the channel does not ship to, a promotion that ended or is not assigned, a product that is not visible, stock, a tier price the listing does not show). Nothing is ordered; the cart is deleted.
- `storefront_search` searches a sales channel like a customer and explains one product on request: its position, or why it is missing (inactive, not visible, link-only, closeout without stock, not in the search index, no keyword matching the term).
- `shop_pulse` compares today with the same hours of the same weekday in recent weeks, weighs the current quiet spell with a Poisson estimate and watches failed payments. The audit gained `checkout_silent` (critical) for an unusual silence: seventeen checks now.
- `shopware-mcp setup` logs in as an admin once and creates a role with exactly the privileges the tools need, measured against a real shop, plus an integration that is not an administrator, verifies both with the doctor and prints or writes the host config. `--allow-write`, `--rotate`, `--dry-run`, `--plugin-updates`. The doctor now checks every association read each tool needs and reports missing optional privileges as reduced coverage.
- `shopware-mcp brief` puts the pulse, the audit and the last seven days on one page: Markdown, JSON, or with `--html` a self-contained HTML file with charts that follows the reader's dark mode and loads nothing from anywhere. `audit` and `report` take `--html` too; `brief` and `audit` post a short summary to Slack with `--slack`; `--tz` sets the time zone for "today".
- The repository is a GitHub Action: `uses: bnymnDev/shopware-mcp@v0.8.0` runs the audit, writes the job summary, exposes the counts as outputs and fails the job on the chosen severity.
- Extension packs can declare the ACL privileges their plugin's routes need; the FroshTools pack does.
- New recordings of the pulse, the customer's view and setup, and a real example brief on the website.
