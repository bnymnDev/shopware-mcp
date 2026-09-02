import { ZodError } from "zod";

/** Compact error shape returned to the agent for every failure. */
export interface ErrorShape {
  /** HTTP status from Shopware, 0 for network errors. */
  status: number;
  /** Shopware error code (e.g. `FRAMEWORK__...`), OAuth error, or an internal code. */
  code: string;
  detail: string;
}

export class ShopwareMcpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(status: number, code: string, detail: string) {
    super(`${code} (${status}): ${detail}`);
    this.name = "ShopwareMcpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  toJSON(): { error: ErrorShape } {
    return { error: { status: this.status, code: this.code, detail: this.detail } };
  }
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null;

/**
 * Map a non-2xx Shopware response body into a ShopwareMcpError.
 * Handles the Admin API error list (`errors[0].code/detail`) and OAuth error bodies.
 */
export function fromHttpResponse(status: number, body: unknown): ShopwareMcpError {
  if (isRecord(body)) {
    const errors = body.errors;
    if (Array.isArray(errors) && errors.length > 0 && isRecord(errors[0])) {
      const first = errors[0];
      const code = typeof first.code === "string" && first.code ? first.code : `HTTP_${status}`;
      const detail =
        (typeof first.detail === "string" && first.detail) ||
        (typeof first.title === "string" && first.title) ||
        `HTTP ${status}`;
      return new ShopwareMcpError(status, code, detail);
    }
    if (typeof body.error === "string") {
      const detail =
        (typeof body.error_description === "string" && body.error_description) ||
        (typeof body.message === "string" && body.message) ||
        (typeof body.hint === "string" && body.hint) ||
        body.error;
      return new ShopwareMcpError(status, body.error.toUpperCase(), detail);
    }
    if (typeof body.message === "string") {
      return new ShopwareMcpError(status, `HTTP_${status}`, body.message);
    }
  }
  if (typeof body === "string" && body.trim()) {
    return new ShopwareMcpError(status, `HTTP_${status}`, body.trim().slice(0, 500));
  }
  return new ShopwareMcpError(status, `HTTP_${status}`, `Shopware responded with HTTP ${status}`);
}

export function networkError(cause: unknown): ShopwareMcpError {
  let detail = "Network request to Shopware failed";
  if (cause instanceof Error) {
    detail = cause.message;
    const inner = (cause as { cause?: unknown }).cause;
    if (inner instanceof Error && inner.message) {
      detail = `${detail}: ${inner.message}`;
    } else if (isRecord(inner) && typeof inner.code === "string") {
      detail = `${detail}: ${inner.code}`;
    }
  }
  return new ShopwareMcpError(0, "NETWORK", detail);
}

export function notFound(entity: string, identifier: string): ShopwareMcpError {
  return new ShopwareMcpError(404, "NOT_FOUND", `${entity} "${identifier}" not found`);
}

export function badRequest(detail: string): ShopwareMcpError {
  return new ShopwareMcpError(400, "BAD_REQUEST", detail);
}

/** Convert any thrown value into the `{ error }` payload returned to the agent. */
export function toErrorShape(error: unknown): { error: ErrorShape } {
  if (error instanceof ShopwareMcpError) return error.toJSON();
  if (error instanceof ZodError) {
    const detail = error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return { error: { status: 400, code: "VALIDATION", detail } };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { error: { status: 500, code: "INTERNAL", detail } };
}
