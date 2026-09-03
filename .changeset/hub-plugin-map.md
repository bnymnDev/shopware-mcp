---
"shopware-mcp": patch
---

Fix two mappings in the Merqo tools that only a real shop could reveal. The hub returns its plugin
map keyed by plugin name rather than as a list, so `merqo_health` reported no plugins at all. Cart
snapshots store `unitPrice` and `totalPrice` per line item, not a single `price`, so
`merqo_abandoned_carts` dropped the amounts. Both shapes are now covered by fixtures taken from a
live Shopware 6.7 and by an end-to-end test that fails if they drift again.
