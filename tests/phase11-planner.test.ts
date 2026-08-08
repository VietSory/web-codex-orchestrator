import test from "node:test";
import assert from "node:assert/strict";
import { deriveNextTransition, type LifecycleSnapshot } from "../src/orchestration/planner.js";

const base: LifecycleSnapshot = { registered_artifact_sha256: "a".repeat(64), executor_state: "READY_FOR_PUBLISH", publish_state: "PUSHED", draft_pr_state: "OPEN", result_bundle_ready: true, web_review_state: "PENDING", revision_state: null, revision_result_ready: false };

test("P11-PLAN-001 lifecycle derives each single-PR transition without latest-file guesses", () => {
  assert.equal(deriveNextTransition({ ...base, registered_artifact_sha256: null }).transition, "REGISTER_WEB_PACK");
  assert.equal(deriveNextTransition({ ...base, executor_state: "APPLIED" }).transition, "EXECUTE_REGISTERED_PACK");
  assert.equal(deriveNextTransition({ ...base, publish_state: null }).transition, "PUBLISH");
  assert.equal(deriveNextTransition({ ...base, draft_pr_state: null }).transition, "OPEN_DRAFT_PR");
  assert.equal(deriveNextTransition({ ...base, result_bundle_ready: false }).transition, "PACKAGE_RESULT");
  assert.equal(deriveNextTransition(base).transition, "WAIT_WEB_VERDICT");
  assert.deepEqual(deriveNextTransition({ ...base, web_review_state: "APPROVED" }), { transition: "WAIT_HUMAN", reason: "Web approved the exact Draft PR head; merge remains a human decision.", mutating: false, requires_human: true });
  assert.equal(deriveNextTransition({ ...base, web_review_state: "REVISION_REQUESTED", revision_state: "APPLIED" }).transition, "REVISE");
  assert.equal(deriveNextTransition({ ...base, web_review_state: "REVISION_REQUESTED", revision_state: "RESULT_READY", revision_result_ready: true }).transition, "WAIT_WEB_VERDICT");
});

test("P11-PLAN-002 inconsistent revision snapshot fails closed", () => {
  assert.throws(() => deriveNextTransition({ ...base, web_review_state: "REVISION_REQUESTED", revision_state: "RESULT_READY", revision_result_ready: false }), /no revision Result Bundle/);
});
