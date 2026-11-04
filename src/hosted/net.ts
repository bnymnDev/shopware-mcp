import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The hosted server fetches URLs a stranger typed in: a shop's address and a client's metadata
 * document. Both must be public HTTPS, never an address inside the network the server runs in.
 */
function privateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped?.[1] ? privateAddress(mapped[1]) : false;
  }
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export async function assertPublicUrl(
  value: string,
  options: { allowPrivate?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("not a URL");
  }
  if (options.allowPrivate) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("use http(s)");
    return url;
  }
  if (url.protocol !== "https:") throw new Error("the address must start with https://");
  if (url.username || url.password) throw new Error("no credentials in the address");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error(`${host} cannot be resolved`);
  if (addresses.some(privateAddress)) throw new Error(`${host} is not a public address`);
  return url;
}

export const __test = { privateAddress };
