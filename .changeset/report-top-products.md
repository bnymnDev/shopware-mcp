---
"shopware-mcp": patch
---

Fix `sales_report` returning zero revenue for most top products. Quantity and revenue were read
from two independent top-N aggregations, and because Shopware breaks ties between equally frequent
products arbitrarily, the two lists disagreed and the revenue lookup missed. Revenue is now
resolved against the exact product ids from the first pass. The per-product count is also renamed
to `lineItemCount`, which is what the aggregation actually counts.

Verified against a Shopware 6.7 shop with sixty generated orders: totals, currency split, state
buckets, the timeline and every top product now match the figures computed directly in SQL.
