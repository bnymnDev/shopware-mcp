import { afterAll, afterEach, beforeAll } from "vitest";
import { mock, requests } from "./helpers/shopware.js";

beforeAll(() => mock.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  mock.resetHandlers();
  requests.length = 0;
});
afterAll(() => mock.close());
