import test from "node:test";
import assert from "node:assert/strict";

import { BudgetTracker, defaultAgentLimits } from "../src/execution/budget.js";
import { ExecutionError } from "../src/execution/errors.js";

function isBudgetError(error: unknown): boolean {
  return error instanceof ExecutionError && error.code === "BUDGET_EXHAUSTED";
}

test("BUDGET-HARD-001 missing provider input/output usage is never counted as zero", () => {
  const tracker = new BudgetTracker(defaultAgentLimits(), 0, undefined, () => 0);
  assert.throws(() => tracker.recordTokens(undefined, 1, 0), isBudgetError);
  assert.throws(() => tracker.recordTokens(1, undefined, 0), isBudgetError);
  assert.deepEqual(
    { input: tracker.usage.inputTokens, cached: tracker.usage.cachedInputTokens, output: tracker.usage.outputTokens },
    { input: 0, cached: 0, output: 0 },
  );
});

test("BUDGET-HARD-002 negative or fractional provider counters fail closed", () => {
  const tracker = new BudgetTracker(defaultAgentLimits(), 0, undefined, () => 0);
  for (const values of [
    [-1, 1, 0],
    [1.5, 1, 0],
    [1, -1, 0],
    [1, 1.5, 0],
    [1, 1, -1],
    [1, 1, 0.5],
  ] as const) {
    assert.throws(() => tracker.recordTokens(values[0], values[1], values[2]), isBudgetError);
  }
});

test("BUDGET-HARD-003 explicit zero usage is valid and safe-integer overflow is rejected", () => {
  const tracker = new BudgetTracker(defaultAgentLimits(), 0, {
    inputTokens: Number.MAX_SAFE_INTEGER,
    cachedInputTokens: 0,
    outputTokens: 0,
  }, () => 0);
  tracker.recordTokens(0, 0, 0);
  assert.throws(() => tracker.recordTokens(1, 0, 0), isBudgetError);
});
