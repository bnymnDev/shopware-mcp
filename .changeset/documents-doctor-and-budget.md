---
"shopware-mcp": minor
---

Documents: `order_documents_list` shows an order's invoices, delivery notes, credit notes and
cancellations, `order_document_create` generates one with Shopware's own generator, and
`document_download` hands the PDF to the host as an embedded resource while the model sees only
the metadata. `order_note` writes an internal comment, appending a dated line by default.

Two new commands: `shopware-mcp doctor` reports per tool whether the integration may use it,
probing reads and reading the role for write privileges, and `shopware-mcp init` tests the
credentials and prints or writes the configuration for Claude Desktop, Claude Code, Cursor,
VS Code or Zed.

`SHOPWARE_MCP_MAX_WRITES` caps the real writes a process may perform; dry runs stay free. The
audit gains two checks, storefronts missing a legal page and products without a delivery time,
and the server offers `shopware://order/{orderNumber}` and `shopware://product/{productNumber}`
as resource templates. The nightly end-to-end run now covers Shopware 6.6 and 6.7.
