export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Resolve `globalThis.fetch` lazily so request interceptors (msw) installed later still apply. */
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** Parse a response body as JSON when possible, falling back to text; `undefined` for empty bodies. */
export async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
