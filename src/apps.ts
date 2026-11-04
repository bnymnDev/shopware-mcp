import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { STYLE, TIPS_SCRIPT } from "./html.js";

/**
 * MCP Apps (the io.modelcontextprotocol/ui extension): hosts that support it show a tool's
 * result as an interactive page next to the chat instead of JSON. One page serves every tool
 * that has a view; the server renders the view's HTML, the same as the HTML brief, and sends
 * it in the result's `_meta`, which the host hands to the page and never to the model.
 */
export const EXTENSION_ID = "io.modelcontextprotocol/ui";
export const APP_MIME_TYPE = "text/html;profile=mcp-app";
export const DASHBOARD_URI = "ui://shopware-mcp/dashboard";
/** Where in a tool result's `_meta` the rendered view travels. */
export const VIEW_META_KEY = "shopware-mcp/view";
/** The version of the MCP Apps protocol this page speaks. */
const APP_PROTOCOL = "2026-01-26";

/** `_meta` of a tool that has a view: the current key and the older flat one hosts still read. */
export const toolUiMeta = () => ({
  ui: { resourceUri: DASHBOARD_URI },
  "ui/resourceUri": DASHBOARD_URI,
});

/**
 * Whether to send the rendered view along. Over stdio the client says in its capabilities
 * whether it shows apps; the stateless HTTP transport creates a server per request and never
 * sees the handshake, and the hosts that connect over HTTP are the ones that show apps.
 */
export function wantsViews(server: McpServer): boolean {
  const capabilities = server.server.getClientCapabilities() as
    | { extensions?: Record<string, unknown> }
    | undefined;
  if (!capabilities) return true;
  return Boolean(capabilities.extensions?.[EXTENSION_ID]);
}

/**
 * The page: it introduces itself to the host, takes the theme it is given, waits for a tool
 * result and shows the view inside it. It loads nothing and calls nothing; the CSP the host
 * applies by default (no connections) is all it needs.
 */
const APP_SCRIPT = `
${TIPS_SCRIPT}
(() => {
  let nextId = 1;
  const pending = new Map();
  const send = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const notify = (method, params) => send({ method, params });
  const root = document.getElementById("view");

  const applyContext = (context) => {
    if (!context) return;
    if (context.theme === "dark" || context.theme === "light") {
      document.documentElement.setAttribute("data-theme", context.theme);
    }
  };
  const showResult = (result) => {
    const html = result && result._meta && result._meta["${VIEW_META_KEY}"];
    if (typeof html === "string") {
      root.innerHTML = html;
      bindTips();
    } else {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(result && (result.structuredContent || result.content), null, 2);
      root.replaceChildren(pre);
    }
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id) && !message.method) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(message.error); else resolve(message.result);
      return;
    }
    switch (message.method) {
      case "ui/notifications/tool-result": showResult(message.params); break;
      case "ui/notifications/host-context-changed": applyContext(message.params); break;
      case "ui/notifications/tool-cancelled":
        root.innerHTML = '<p class="muted">Cancelled.</p>'; break;
      case "ui/resource-teardown": send({ id: message.id, result: {} }); break;
      default:
        if (message.id !== undefined && message.method) {
          send({ id: message.id, error: { code: -32601, message: "Method not found" } });
        }
    }
  });

  new ResizeObserver(() => {
    const box = document.documentElement.getBoundingClientRect();
    notify("ui/notifications/size-changed", { width: Math.ceil(box.width), height: Math.ceil(box.height) });
  }).observe(document.documentElement);

  request("ui/initialize", {
    appInfo: { name: "shopware-mcp", version: "1" },
    appCapabilities: {},
    protocolVersion: "${APP_PROTOCOL}",
  }).then((result) => {
    applyContext(result && result.hostContext);
    notify("ui/notifications/initialized", {});
  }).catch(() => notify("ui/notifications/initialized", {}));
})();
`;

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shopware-mcp</title>
<style>${STYLE}
main{padding:16px 16px 24px}
section:first-child{margin-top:0}
pre{white-space:pre-wrap;font-size:12px}
</style>
</head>
<body>
<main id="view"><p class="muted">Loading…</p></main>
<script>${APP_SCRIPT}</script>
</body>
</html>
`;

export function registerApps(server: McpServer): void {
  server.registerResource(
    "dashboard",
    DASHBOARD_URI,
    {
      title: "Shop dashboard",
      description: "The page MCP Apps hosts show for the pulse, the audit, the brief and reports.",
      mimeType: APP_MIME_TYPE,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: APP_MIME_TYPE,
          text: DASHBOARD_HTML,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );
}
