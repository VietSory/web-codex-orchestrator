import test from "node:test";
import assert from "node:assert/strict";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";
import { derivePairStage, formatPairReview, formatPairStatus } from "../src/tui/pair-presenter.js";

function snapshot(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
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

test("PAIR stage is derived from durable lifecycle evidence instead of the coarse local session state", () => {
  assert.equal(derivePairStage(snapshot({ executor_state: "IMPLEMENTING", publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_code_review_state: null, web_review_state: null })), "EXECUTION");
  assert.equal(derivePairStage(snapshot({ executor_state: "VERIFYING", publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_code_review_state: null, web_review_state: null })), "VERIFICATION");
  assert.equal(derivePairStage(snapshot({ executor_state: "ESCALATE_TO_WEB", publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_code_review_state: null, web_review_state: null })), "WEB_IMPLEMENTATION");
  assert.equal(derivePairStage(snapshot({ executor_state: "REPAIR_APPLYING", publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_code_review_state: null, web_review_state: null })), "REVISION");
  assert.equal(derivePairStage(snapshot({ publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_code_review_state: null, web_review_state: null })), "PUBLISHING");
  assert.equal(derivePairStage(snapshot({ draft_pr_state: null, result_bundle_ready: false, web_code_review_state: null, web_review_state: null })), "DRAFT_PR");
  assert.equal(derivePairStage(snapshot({ result_bundle_ready: false, web_code_review_state: null, web_review_state: null })), "RESULT_BUNDLE");
  assert.equal(derivePairStage(snapshot({ web_code_review_state: "PENDING", web_review_state: null })), "TERRA_REVIEW");
  assert.equal(derivePairStage(snapshot({ web_review_state: "PENDING" })), "WEB_FINAL_REVIEW");
  assert.equal(derivePairStage(snapshot({ web_review_state: "REVISION_REQUESTED", revision_state: "APPLYING", revision_result_ready: false })), "REVISION");
  assert.equal(derivePairStage(snapshot()), "AWAITING_HUMAN");
  assert.equal(derivePairStage(snapshot({ executor_state: "FAILED", publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_code_review_state: null, web_review_state: null })), "BLOCKED");
});

test("PAIR status is human-readable and does not leak lifecycle enum names", () => {
  const output = formatPairStatus({
    goal: "Add organization invitations",
    planLocked: true,
    snapshot: snapshot({ web_review_state: "PENDING" }),
    draftPrUrl: "https://github.com/example/repo/pull/42",
  });
  assert.match(output, /PAIR · Final review/);
  assert.match(output, /Goal\s+Add organization invitations/);
  assert.match(output, /Checks\s+passed/);
  assert.match(output, /Code review\s+approved/);
  assert.match(output, /Draft PR\s+https:\/\/github\.com\/example\/repo\/pull\/42/);
  assert.match(output, /Final review\s+in progress/);
  assert.match(output, /Next\s+WCO is waiting for the final review/);
  assert.doesNotMatch(output, /READY_FOR_PUBLISH|PUSHED|READY_FOR_WEB_REVIEW|IMPLEMENTATION_REGISTERED/);
});

test("PAIR review summary focuses on evidence and the next user action", () => {
  const output = formatPairReview({
    snapshot: snapshot(),
    checksPassed: true,
    codeReview: "independent review · approved",
    draftPrUrl: "https://github.com/example/repo/pull/42",
    gitVerified: true,
  });
  assert.match(output, /Review · Ready for you/);
  assert.match(output, /Checks\s+passed/);
  assert.match(output, /Code review\s+independent review · approved/);
  assert.match(output, /Final review\s+approved/);
  assert.match(output, /Git result\s+verified/);
  assert.match(output, /Next\s+review the Draft PR and merge when ready/);
});
