import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("review provider qualification shares one configured turn token and wall-clock budget across both cases", async () => {
  const source = await readFile(path.resolve("scripts/benchmark-review-provider.mts"), "utf8");

  assert.match(source, /class ReviewProviderBudget/);
  assert.match(source, /this\.usage\.turns >= this\.limits\.maximum_total_agent_turns/);
  assert.match(source, /this\.limits\.maximum_total_seconds \* 1_000/);
  assert.match(source, /Math\.min\(configuredTurnMs, remainingTotalMs\)/);
  assert.match(source, /this\.usage\.input_tokens > this\.limits\.maximum_total_input_tokens/);
  assert.match(source, /this\.usage\.output_tokens > this\.limits\.maximum_total_output_tokens/);
  assert.match(source, /signal: options\.budget\.turnSignal\(\)/);
  assert.match(source, /options\.budget\.record\(input, cached, output\)/);

  const budgetCreations = source.match(/new ReviewProviderBudget\(limits\)/g) ?? [];
  assert.equal(budgetCreations.length, 1, "the two qualification cases must not reset provider budget independently");
  assert.match(source, /runCase\(\{ name: "hidden_defect"[\s\S]*budget \}\);/);
  assert.match(source, /runCase\(\{ name: "clean_twin"[\s\S]*budget \}\);/);
  assert.match(source, /configured_budget:/);
  assert.match(source, /provider_turns: budget\.usage\.turns/);
  assert.match(source, /input_tokens: budget\.usage\.input_tokens/);
  assert.match(source, /output_tokens: budget\.usage\.output_tokens/);
});
