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
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
    ...overrides,
  };
}

test("V04-UX-007 PAIR completes after verification + selected reviewer + exact Draft PR result, without Web review", () => {
  assert.equal(pairSessionCanComplete(readySnapshot()), true);
  assert.equal(pairSessionCanComplete(readySnapshot({ web_review_state: "PENDING" })), true, "normal PAIR does not wait for a second Web review");
  assert.equal(pairSessionCanComplete(readySnapshot({ executor_state: "VERIFYING" })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ publish_state: null })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ draft_pr_state: null })), false);
  assert.equal(pairSessionCanComplete(readySnapshot({ result_bundle_ready: false })), false);
});
