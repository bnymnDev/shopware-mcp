import { afterAll, afterEach, beforeAll } from "vitest";
import { mock, requests } from "./helpers/shopware.js";

beforeAll(() => mock.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  mock.resetHandlers();
  requests.length = 0;
});
// Some suites close the mock themselves to reach a real loopback server; msw 3 refuses a second close.
afterAll(() => {
  if (mock.readyState !== 0) mock.close();
});
