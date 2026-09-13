---
"shopware-mcp": minor
---

Three new tools, a sixteenth audit check and the intro video.

- `order_documents_bulk_create` generates one document type for up to fifty orders in one request: the given orders, or by default the paid, not cancelled orders that have no such document yet, oldest first. The dry run lists the orders, the request and the exact `apply` arguments; a real run reads the new documents back and reports the created document per order, the orders Shopware skipped and its per-order errors. Every order counts as one real write against `SHOPWARE_MCP_MAX_WRITES`, checked before anything is sent.
- `tag_assign` adds tags to or removes tags from a customer, order or product by name, matched without regard to case like Shopware does. Missing tags are created in the same request, other tags on the record stay, and an unchanged record is reported as such. `shopware-mcp doctor` knows the tag relation privileges it needs.
- `scheduled_tasks_list` reads Shopware's scheduled tasks with status, interval, last and next run, and flags tasks that are overdue past a grace period, failed, or stuck running for over a day. Read-only.
- `shop_audit` gained the check `scheduled_tasks_stuck` (warning): tasks overdue by more than an hour or failed, which explains stale search results, missing thumbnails and unsent mails.
- The write budget moved into a shared module so bulk tools can charge it per record; the per-call charge is unchanged.
- The thirty-second intro video is on the website with a caption track, as a poster in both READMEs, and rendered from `docs/video/`.
- A new recording shows the bulk invoice flow, the scheduled tasks and a tag dry run against a real shop.
