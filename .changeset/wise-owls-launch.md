---
"shopware-mcp": minor
---

Nine new tools, two new audit checks, a customer resource, two prompts, a website.

Read tools: `order_history` (every order, payment and delivery transition with who triggered it), `reviews_search` (ratings, text, moderation state, average points), `payment_methods_list` and `shipping_methods_list` (with sales channel assignment, availability rule, delivery time), `customer_report` (new accounts by group and guest share, distinct and repeat customers, guest order share, top customers by revenue, comparison with the previous period).

Write tools, all guarded by a dry run: `product_create` (simple product with gross price, derived net price, tax by id, rate or the shop's default, stock, visibility per sales channel), `promotion_create` (one cart discount, optional code, validity, redemption limits, sales channels; created inactive unless asked), `customer_update` (active flag and group), `review_moderate` (approve or hide, public reply). `stock_set` accepts a `delta` relative to the current stock.

`shop_audit` also reports active products invisible in every sales channel and reviews awaiting moderation (13 checks). New resource template `shopware://customer/{customerNumber}` and the prompts `customer_profile` and `review_moderation`. `doctor` knows the privileges of every new tool.

Docs: four new real recordings (ship and history, product and promotion, moderation, customer report), a landing page deployed to GitHub Pages from `site/`, and the source of the intro video under `docs/video/`.
