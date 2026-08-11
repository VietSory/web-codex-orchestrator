import test from "node:test";
import assert from "node:assert/strict";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";
import { pairSessionCanComplete } from "../src/tui/pair-completion.js";

function snapshot(webReviewState: LifecycleSnapshot["web_review_state"]): LifecycleSnapshot {
  return {
    registered_artifact_sha256: "a".repeat(64),
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: true,
    web_review_state: webReviewState,
    revision_state: null,
    revision_result_ready: false,
  };
}

test("V04-UX-007 PAIR local completion requires the authoritative approved human boundary", () => {
  assert.equal(pairSessionCanComplete(snapshot("APPROVED")), true);
  assert.equal(pairSessionCanComplete(snapshot("PENDING")), false);
  assert.equal(pairSessionCanComplete(snapshot("REVISION_REQUESTED")), false);
  assert.equal(pairSessionCanComplete(snapshot("ESCALATED")), false);
});
