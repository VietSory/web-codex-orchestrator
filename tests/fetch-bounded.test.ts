import test from "node:test";
import assert from "node:assert/strict";
import { createBoundedFetch } from "../src/runtime/fetch-bounded.js";

test("FETCH-BOUND-001 aborts a hung request at the configured deadline", async () => {
  let aborted = false;
  const bounded = createBoundedFetch({
    timeoutMs: 20,
    fetchImpl: async (_input, init) => {
      await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => {
        aborted = true;
        resolve();
      }, { once: true }));
      throw init?.signal?.reason ?? new Error("aborted");
    },
  });
  await assert.rejects(() => bounded("https://example.invalid"), /deadline/);
  assert.equal(aborted, true);
});

test("FETCH-BOUND-002 relays caller cancellation", async () => {
  const controller = new AbortController();
  const bounded = createBoundedFetch({
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw init?.signal?.reason ?? new Error("aborted");
    },
  });
  const pending = bounded("https://example.invalid", { signal: controller.signal });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(() => pending, /caller cancelled/);
});
