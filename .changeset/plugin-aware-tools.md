---
"shopware-mcp": minor
---

Plugin-aware tools: the server now detects which extensions a shop has installed and registers
extra tools for the ones it knows, in the background and without delaying startup. A shop without
the extension sees the unchanged core tool set, and `--no-extensions` turns detection off. The
first supported suite is Merqo, adding compliance status, incoming e-invoices, returns and
abandoned carts.

`shop_audit` additionally reports which EU duties (structured e-invoicing, accessible storefront,
packaging reporting, AI labelling) appear to be covered by an active extension. It names the duty
and its deadline, never a product, and can be switched off with `complianceChecks: false`.

`entity_search` and explicitly requested raw fields now truncate very long values, so a stored file
such as an archived invoice can no longer fill an agent's context window.
