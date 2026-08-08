import test from "node:test";
import assert from "node:assert/strict";
import { retryableFailureCode } from "../src/orchestration/retry-policy.js";

for (const code of ["REVISION_INTERRUPTED", "REVISION_OPERATIONAL_ERROR", "REVISION_PUSH_FAILED"] as const) {
  test(`REVISION-RETRY-001 ${code} remains retryable across the outer orchestration boundary`, () => {
    assert.equal(retryableFailureCode(code), true);
  });
}

test("REVISION-RETRY-002 terminal revision policy failures remain non-retryable", () => {
  assert.equal(retryableFailureCode("REVISION_POLICY_BLOCKED"), false);
  assert.equal(retryableFailureCode("REVISION_BUDGET_EXHAUSTED"), false);
});
