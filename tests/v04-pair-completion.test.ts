import test from "node:test";
import assert from "node:assert/strict";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";
import { pairSessionCanComplete } from "../src/tui/pair-completion.js";

function readySnapshot(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    registered_artifact_sha256: "a".repeat(64),
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: true,
    web_code_review_state: "APPROVED",
    web_review_state: "APPROVED",
    revision_state: null,
    revision_result_ready: false,
    ...overrides,
  };
}

test("V04-UX-007 PAIR completes only after selected code review, exact Draft PR result, and Web final APPROVE", () => {
  assert.equal(pairSessionCanComplete(readySnapshot()), true);
  const missingCodeReview = readySnapshot();
  delete missingCodeReview.web_code_review_state;
  assert.equal(pairSessionCanComplete(missingCodeReview), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_code_review_state: null })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_code_review_state: "PENDING" })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_code_review_state: "REVISION_REQUESTED" })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_code_review_state: "ESCALATED" })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_review_state: null })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_review_state: "PENDING" })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_review_state: "REVISION_REQUESTED" })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_review_state: "ESCALATED" })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ executor_state: "VERIFYING" })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ publish_state: null })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ draft_pr_state: null })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ result_bundle_ready: false })), false);
});
