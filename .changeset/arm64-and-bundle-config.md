---
"shopware-mcp": patch
---

The container image is now built for `linux/arm64` as well as `linux/amd64`, so it runs natively
on Apple Silicon and ARM servers. The Claude Desktop bundle describes the current write tools,
asks for an optional write budget alongside the credentials, and passes it as
`SHOPWARE_MCP_MAX_WRITES`. A Smithery configuration lets that directory start the server with a
user's shop credentials.
