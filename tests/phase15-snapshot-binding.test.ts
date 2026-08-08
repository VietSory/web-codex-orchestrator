import test from "node:test";
import assert from "node:assert/strict";
import {
  revisionReceiptBoundToWebReview,
  revisionResultReadyForWebReview,
} from "../src/orchestration/snapshot-reader.js";

const RUN_ID = `TASK-P15-SNAPSHOT:${"a".repeat(64)}`;
const REQUEST = "b".repeat(64);
const VERDICT = "c".repeat(64);
const OLD_HEAD = "3".repeat(40);
const NEW_HEAD = "4".repeat(40);

function review(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    state: "REVISION_REQUESTED",
    review_round: 2,
    revision_request_sha256: REQUEST,
    verdict_sha256: VERDICT,
    fresh_attested_head_sha: OLD_HEAD,
    pull_request_number: 42,
    ...overrides,
  } as never;
}

function revision(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    state: "RESULT_READY",
    revision_round: 2,
    revision_request_sha256: REQUEST,
    previous_verdict_sha256: VERDICT,
    previous_pr_head_sha: OLD_HEAD,
    pull_request_number: 42,
    new_published_commit_sha: NEW_HEAD,
    remote_branch_sha: NEW_HEAD,
    result_bundle_sha256: "d".repeat(64),
    result_manifest_sha256: "e".repeat(64),
    next_review_round: 3,
    ...overrides,
  } as never;
}

test("P15-SNAPSHOT-001 exact revision authority and terminal result are recognized", () => {
  assert.equal(revisionReceiptBoundToWebReview(RUN_ID, review(), revision()), true);
  assert.equal(revisionResultReadyForWebReview(RUN_ID, review(), revision()), true);
});

test("P15-SNAPSHOT-002 stale request, head, PR or publication cannot skip REVISE", () => {
  assert.equal(revisionResultReadyForWebReview(RUN_ID, review(), revision({ revision_request_sha256: "f".repeat(64) })), false);
  assert.equal(revisionResultReadyForWebReview(RUN_ID, review(), revision({ previous_pr_head_sha: "5".repeat(40) })), false);
  assert.equal(revisionResultReadyForWebReview(RUN_ID, review(), revision({ pull_request_number: 43 })), false);
  assert.equal(revisionResultReadyForWebReview(RUN_ID, review(), revision({ remote_branch_sha: "6".repeat(40) })), false);
  assert.equal(revisionResultReadyForWebReview(RUN_ID, review({ state: "APPROVED" }), revision()), false);
});
