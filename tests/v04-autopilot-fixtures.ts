import type { ExecutionReceipt } from "../src/execution/contracts.js";
import type { DraftPullRequestReceipt } from "../src/pull-request/contracts.js";
import type { GitPublishReceipt } from "../src/publish/contracts.js";
import type { ResultBundleReceipt } from "../src/result-bundle/contracts.js";
import type { RevisionReceipt } from "../src/revision/contracts.js";
import type { WebReviewReceipt } from "../src/web-review/contracts.js";

export const COMMIT_1 = "1".repeat(40);
export const COMMIT_2 = "2".repeat(40);
export const READY_EXECUTION = { state: "READY_FOR_PUBLISH", errors: [] } as unknown as ExecutionReceipt;
export const PUSHED = { state: "PUSHED", commit_sha: COMMIT_1, remote_branch_sha: COMMIT_1 } as unknown as GitPublishReceipt;
export const READY_REVISION = { state: "RESULT_READY", result_bundle_sha256: "b".repeat(64), new_published_commit_sha: COMMIT_2, remote_branch_sha: COMMIT_2 } as unknown as RevisionReceipt;

export function openDraft(commit = COMMIT_1): DraftPullRequestReceipt {
  return {
    state: "OPEN",
    observed_draft: true,
    observed_state: "open",
    pull_number: 31,
    pull_url: "https://github.com/example/repo/pull/31",
    expected_head_sha: commit,
    observed_head_sha: commit,
    base_branch: "main",
    observed_base_branch: "main",
  } as unknown as DraftPullRequestReceipt;
}

export function readyResult(runId: string, commit = COMMIT_1): ResultBundleReceipt {
  return {
    result_bundle_version: "1.1",
    run_id: runId,
    state: "READY_FOR_WEB_REVIEW",
    archive_sha256: "a".repeat(64),
    manifest_sha256: "b".repeat(64),
    reviewed_entry_set_sha256: "c".repeat(64),
    spec_set_sha256: "d".repeat(64),
    published_commit_sha: commit,
    remote_branch_sha: commit,
    pull_request: {
      number: 31,
      url: "https://github.com/example/repo/pull/31",
      state: "open",
      draft: true,
      head_branch: "agent/test",
      head_sha: commit,
      base_branch: "main",
      title_sha256: "e".repeat(64),
    },
  } as unknown as ResultBundleReceipt;
}

export function webReview(state: "APPROVED" | "REVISION_REQUESTED" | "ESCALATED", runId: string, commit = COMMIT_1): WebReviewReceipt {
  return {
    phase_version: "1.1",
    run_id: runId,
    review_mode: commit === COMMIT_1 ? "INITIAL" : "REVISION",
    review_round: commit === COMMIT_1 ? 1 : 2,
    state,
    verdict_sha256: "f".repeat(64),
    decision_event_sha256: "a".repeat(64),
    published_commit_sha: commit,
    pull_request_number: 31,
    observed_head_sha: commit,
    fresh_attested_head_sha: commit,
    action: state === "APPROVED" ? "ASK_USER_TO_MERGE" : state === "REVISION_REQUESTED" ? "NO_USER_MERGE_PROMPT" : "NOTIFY_USER_EXCEPTION",
    completed_at: "2030-01-01T00:00:00.000Z",
  } as unknown as WebReviewReceipt;
}
