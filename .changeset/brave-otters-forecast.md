---
"shopware-mcp": minor
---

A stock forecast, aggregations for any entity, two more audit checks, the audit and the sales report on the command line, three more hosts for `init`.

`stock_forecast` lists the products that run out within a horizon at the pace of the last `days`: units sold, days of cover, run-out date and a reorder quantity that covers the horizon plus a restock period; the `reorder_list` prompt turns it into a purchase list. `entity_search` accepts Shopware `aggregations` (terms, sum, avg, min, max, count, stats, histogram, one nested metric) with credential fields refused. `shop_audit` also reports paid orders without an invoice document and products running out (15 checks, `forecastDays`).

`shopware-mcp audit` and `shopware-mcp report` print the audit and the sales report as Markdown (or `--json`); the audit exits with 1 on critical findings, or on warnings with `--fail-on warning`, for cron and CI. `init` writes configs for Windsurf, Gemini CLI and Codex CLI (a `[mcp_servers.shopware]` table in `config.toml`) as well.
