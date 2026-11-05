---
"shopware-mcp": patch
---

fix: `tag_assign` derives the id of a tag it creates from the tag's name, so the dry run shows the exact request the real write sends, and two calls creating the same tag agree on its id.
