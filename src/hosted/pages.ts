import { esc, STYLE } from "../html.js";

const PAGE_STYLE = `${STYLE}
main{max-width:560px}
form{display:grid;gap:14px;margin-top:20px}
label{display:grid;gap:4px;font-weight:600;font-size:14px}
label small{font-weight:400;color:var(--ink2)}
input{font:inherit;padding:9px 11px;border:1px solid var(--base);border-radius:8px;background:var(--surface);color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;font-weight:600;padding:10px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.who{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:12px 16px}
.error{border-left:4px solid var(--critical);background:var(--surface);border-radius:8px;padding:10px 14px}
ol{padding-left:20px;color:var(--ink2)}
code{font-size:13px}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

export interface ConsentPage {
  requestId: string;
  clientName: string;
  redirectHost: string;
  shopUrl?: string;
  error?: string;
}

/** Where a person connects their shop: who asks, what it may do, and the Integration's keys. */
export function consentPage(options: ConsentPage): string {
  return page(
    "Connect your Shopware shop",
    `<h1>Connect your Shopware shop</h1>
<p class="who"><strong>${esc(options.clientName)}</strong> (${esc(options.redirectHost)}) asks to
read your shop through shopware-mcp: orders, products, customers and reports. It cannot change
anything: this server only offers read tools.</p>
${options.error ? `<p class="error" role="alert">${esc(options.error)}</p>` : ""}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="request" value="${esc(options.requestId)}">
<label>Shop address <small>The URL of your shop, e.g. https://shop.example.com</small>
<input name="shop_url" type="url" required placeholder="https://shop.example.com" value="${esc(options.shopUrl ?? "")}"></label>
<label>Access key ID <small>From the Integration, starts with SWIA</small>
<input name="client_id" required spellcheck="false" autocapitalize="off"></label>
<label>Secret access key
<input name="client_secret" type="password" required spellcheck="false"></label>
<button type="submit">Connect</button>
</form>
<h2 style="margin-top:28px">Where the keys come from</h2>
<ol>
<li>Best: run <code>npx shopware-mcp setup --url https://your-shop</code> once. It creates an
Integration whose role can read exactly what the tools need, and prints the keys.</li>
<li>Or in the Shopware admin: Settings → System → Integrations → Add integration, with a role
that can read orders, products and customers.</li>
</ol>
<p class="muted">The keys are stored encrypted and used only to answer your assistant. Delete the
Integration in Shopware to cut access at any time.</p>`,
  );
}

export function errorPage(title: string, detail: string): string {
  return page(title, `<h1>${esc(title)}</h1><p class="error">${esc(detail)}</p>`);
}

/** The root of a hosted server without a website of its own. */
export function homePage(publicUrl: string): string {
  return page(
    "shopware-mcp",
    `<h1>shopware-mcp</h1>
<p>An MCP server for Shopware 6. Add this address as a connector in your assistant:</p>
<p class="who"><code>${esc(publicUrl)}/mcp</code></p>
<p class="muted">It asks for your shop's address and an Integration's keys on the first use.
Read-only. <a href="https://github.com/bnymnDev/shopware-mcp">Source and documentation</a>.</p>`,
  );
}
