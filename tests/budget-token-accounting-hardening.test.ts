import assert from "node:assert/strict";
import test from "node:test";
import { BudgetTracker } from "../src/execution/budget.js";
import { ExecutionError } from "../src/execution/errors.js";

function limits() {
  return {
    maximum_implementation_iterations: 10,
    maximum_internal_review_rounds: 10,
    maximum_sol_review_rounds: 10,
    maximum_total_agent_turns: 10,
    maximum_turn_seconds: 900,
    maximum_total_seconds: 7200,
    maximum_total_input_tokens: 100,
    maximum_total_output_tokens: 100,
  };
}

test("cached input is observed but not double-counted against total input budget", () => {
  const budget = new BudgetTracker(limits(), 0, undefined, () => 0);
  budget.recordTokens(75, 1, 25);
  assert.deepEqual(
    { input: budget.usage.inputTokens, cached: budget.usage.cachedInputTokens, output: budget.usage.outputTokens },
    { input: 75, cached: 25, output: 1 },
  );
  assert.doesNotThrow(() => budget.recordTokens(25, 1, 25), "75+25 total input is exactly the configured 100-token budget; cached is a subset, not extra input");
  assert.throws(() => budget.recordTokens(1, 0, 0), (error: unknown) => error instanceof ExecutionError && error.code === "BUDGET_EXHAUSTED");
});

test("cached input cannot exceed total input usage", () => {
  const budget = new BudgetTracker(limits(), 0, undefined, () => 0);
  assert.throws(() => budget.recordTokens(5, 1, 6), (error: unknown) => error instanceof ExecutionError && error.code === "BUDGET_EXHAUSTED");
});

test("missing cached token usage fails closed instead of silently undercounting", () => {
  const budget = new BudgetTracker(limits(), 0, undefined, () => 0);
  assert.throws(() => budget.recordTokens(1, 1, undefined), (error: unknown) => error instanceof ExecutionError && error.code === "BUDGET_EXHAUSTED");
});

test("token overflow fails closed before unsafe integer accounting", () => {
  const permissive = { ...limits(), maximum_total_input_tokens: Number.MAX_SAFE_INTEGER, maximum_total_output_tokens: Number.MAX_SAFE_INTEGER };
  const budget = new BudgetTracker(permissive, 0, {
    inputTokens: Number.MAX_SAFE_INTEGER,
    cachedInputTokens: 0,
    outputTokens: 0,
  }, () => 0);
  assert.throws(() => budget.recordTokens(1, 0, 0), (error: unknown) => error instanceof ExecutionError && error.code === "BUDGET_EXHAUSTED");
});
