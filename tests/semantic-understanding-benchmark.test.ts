import assert from "node:assert/strict";
import test from "node:test";
import { scoreSemanticUnderstanding, type SemanticUnderstandingCandidate, type SemanticUnderstandingGold } from "../src/benchmark/semantic-understanding.js";

const gold: SemanticUnderstandingGold = {
  required_component_ids: ["C_SESSION", "C_HISTORY"],
  required_invariant_ids: ["I_FOCUS", "I_AUTHORITY"],
  required_risk_ids: ["R_WRONG_TASK", "R_DUPLICATE_RUN"],
  required_unknown_ids: ["U_CONTINUE_SEMANTICS"],
  rejected_assumption_ids: ["A_LATEST_IS_CURRENT"],
  critical_ids: ["I_FOCUS", "I_AUTHORITY", "R_WRONG_TASK"],
};

const perfect: SemanticUnderstandingCandidate = {
  affected_component_ids: ["C_SESSION", "C_HISTORY"],
  invariant_ids: ["I_FOCUS", "I_AUTHORITY"],
  risk_ids: ["R_WRONG_TASK", "R_DUPLICATE_RUN"],
  unknown_ids: ["U_CONTINUE_SEMANTICS"],
  rejected_assumption_ids: ["A_LATEST_IS_CURRENT"],
};

test("semantic understanding scorer gives a complete category-correct candidate full credit", () => {
  const score = scoreSemanticUnderstanding(perfect, gold);
  assert.equal(score.weighted_quality, 1);
  assert.equal(score.critical_recall, 1);
  assert.equal(score.unnecessary_selection_rate, 0);
  assert.deepEqual(score.critical_misses, []);
  assert.deepEqual(score.missing_required, []);
  assert.deepEqual(score.unexpected_selected, []);
});

test("critical semantic misses are penalized more heavily than ordinary omissions", () => {
  const score = scoreSemanticUnderstanding({
    ...perfect,
    invariant_ids: ["I_FOCUS"],
    risk_ids: ["R_DUPLICATE_RUN"],
  }, gold);
  assert.deepEqual(score.critical_misses, ["I_AUTHORITY", "R_WRONG_TASK"]);
  assert.equal(score.critical_recall, 1 / 3);
  assert.ok(score.weighted_quality < 0.5);
  assert.ok(score.missing_required.includes("I_AUTHORITY"));
  assert.ok(score.missing_required.includes("R_WRONG_TASK"));
});

test("putting a critical ID in the wrong semantic category does not satisfy the gold item", () => {
  const score = scoreSemanticUnderstanding({
    ...perfect,
    invariant_ids: ["I_FOCUS"],
    risk_ids: ["R_WRONG_TASK", "R_DUPLICATE_RUN", "I_AUTHORITY"],
  }, gold);
  assert.ok(score.critical_misses.includes("I_AUTHORITY"));
  assert.ok(score.missing_required.includes("I_AUTHORITY"));
  assert.ok(score.unexpected_selected.includes("I_AUTHORITY"));
  assert.ok(score.weighted_quality < 1);
});

test("unnecessary scope is visible and reduces quality without hiding correct recall", () => {
  const score = scoreSemanticUnderstanding({
    ...perfect,
    affected_component_ids: ["C_SESSION", "C_HISTORY", "C_UNRELATED"],
  }, gold);
  assert.equal(score.component_recall, 1);
  assert.equal(score.component_precision, 2 / 3);
  assert.ok(score.unnecessary_selection_rate > 0);
  assert.ok(score.weighted_quality < 1);
  assert.deepEqual(score.unexpected_selected, ["C_UNRELATED"]);
});

test("benchmark truth rejects category-ambiguous gold IDs and malformed candidate IDs", () => {
  assert.throws(() => scoreSemanticUnderstanding(perfect, {
    ...gold,
    required_risk_ids: [...gold.required_risk_ids, "I_FOCUS"],
  }), /benchmark truth must be category-unique/i);

  assert.throws(() => scoreSemanticUnderstanding({
    ...perfect,
    risk_ids: ["not-valid"],
  }, gold), /invalid semantic ID/i);
});
