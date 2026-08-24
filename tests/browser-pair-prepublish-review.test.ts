import assert from "node:assert/strict";
import test from "node:test";
import { deriveNextTransition, type LifecycleSnapshot } from "../src/orchestration/planner.js";
import { pairSessionCanComplete } from "../src/tui/pair-completion.js";
import { derivePairStage } from "../src/tui/pair-presenter.js";

function reviewedBrowserSnapshot(): LifecycleSnapshot {
  return {
    registered_artifact_sha256: "a".repeat(64),
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: true,
    browser_review_gate_passed: true,
    web_code_review_state: null,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };
}

test("browser PAIR completes after one prepublish review without post-PR model review", () => {
  const snapshot = reviewedBrowserSnapshot();
  assert.equal(deriveNextTransition(snapshot).transition, "WAIT_HUMAN");
  assert.equal(pairSessionCanComplete(snapshot), true);
  assert.equal(derivePairStage(snapshot), "AWAITING_HUMAN");
});

test("a published result without the durable browser-review gate cannot impersonate reviewed browser PAIR", () => {
  const snapshot = { ...reviewedBrowserSnapshot(), browser_review_gate_passed: false };
  assert.equal(deriveNextTransition(snapshot).transition, "WAIT_WEB_VERDICT");
  assert.equal(pairSessionCanComplete(snapshot), false);
});

test("browser review approval never publishes before the exact reviewed result is ready", () => {
  const snapshot = { ...reviewedBrowserSnapshot(), publish_state: null, draft_pr_state: null, result_bundle_ready: false };
  assert.equal(deriveNextTransition(snapshot).transition, "PUBLISH");
  assert.equal(pairSessionCanComplete(snapshot), false);
});
