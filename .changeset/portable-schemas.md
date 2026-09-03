---
"shopware-mcp": patch
---

Emit every union in a tool schema as `anyOf` branches with a single `type` each. Zod collapses a
primitive-only union into `type: ["string", "number", …]`, which is legal JSON Schema but is read
as a single string by several MCP clients, which then reject the tool or drop the constraint. The
filter value, its list form and the range bounds were affected, so this touched every search tool.
A test now walks the schema of every tool, core and plugin-aware, and fails on any array-valued
`type`.
