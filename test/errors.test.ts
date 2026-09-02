import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromHttpResponse, networkError, ShopwareMcpError, toErrorShape } from "../src/errors.js";
import { fixture } from "./helpers/shopware.js";

describe("errors", () => {
  it("maps Shopware error lists", () => {
    const error = fromHttpResponse(404, fixture("error-404"));
    expect(error.toJSON()).toEqual({
      error: {
        status: 404,
        code: "FRAMEWORK__RESOURCE_NOT_FOUND",
        detail: 'The "product" entity with id "deadbeef" does not exist.',
      },
    });
  });

  it("maps OAuth errors", () => {
    const error = fromHttpResponse(401, fixture("error-oauth"));
    expect(error.code).toBe("INVALID_CLIENT");
    expect(error.detail).toBe("Client authentication failed");
  });

  it("falls back for plain bodies", () => {
    expect(fromHttpResponse(502, "<html>Bad Gateway</html>").detail).toContain("Bad Gateway");
    expect(fromHttpResponse(500, undefined).code).toBe("HTTP_500");
    expect(fromHttpResponse(403, { message: "nope" }).detail).toBe("nope");
  });

  it("maps network errors to status 0", () => {
    const cause = new TypeError("fetch failed");
    (cause as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const error = networkError(cause);
    expect(error.status).toBe(0);
    expect(error.code).toBe("NETWORK");
    expect(error.detail).toContain("ECONNREFUSED");
  });

  it("converts zod and unknown errors", () => {
    const zodResult = z.object({ stock: z.number() }).safeParse({ stock: "x" });
    expect(zodResult.success).toBe(false);
    if (!zodResult.success) {
      const shape = toErrorShape(zodResult.error);
      expect(shape.error.code).toBe("VALIDATION");
      expect(shape.error.detail).toContain("stock");
    }
    expect(toErrorShape(new Error("boom")).error).toEqual({
      status: 500,
      code: "INTERNAL",
      detail: "boom",
    });
    expect(toErrorShape(new ShopwareMcpError(418, "TEAPOT", "short")).error.status).toBe(418);
  });
});
