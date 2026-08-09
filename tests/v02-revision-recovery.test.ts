import test from "node:test";
import assert from "node:assert/strict";
import { assertRevisionReceiptAuthority } from "../src/revision/revision-authority.js";
import { RevisionError, type RevisionState } from "../src/revision/contracts.js";

function fixture(state: RevisionState, resumeState: any = null): { receipt: any; expected: any } {
  const receipt: any = {
    state,
    resume_state: resumeState,
    run_id: `TASK:${"1".repeat(64)}`,
    revision_round: 1,
    revision_request_sha256: "2".repeat(64),
    spec_set_sha256: "3".repeat(64),
    previous_result_bundle_sha256: "4".repeat(64),
    previous_result_receipt_sha256: "5".repeat(64),
    previous_verdict_sha256: "6".repeat(64),
    previous_published_commit_sha: "7".repeat(40),
    previous_pr_head_sha: "8".repeat(40),
    pull_request_number: 42,
    branch_name: "codex/feature",
    base_branch: "main",
    worktree_path: "/trusted/worktree",
    implementer: { model: "terra", reasoning_effort: "high" },
    terra_review: { model: "terra", reasoning_effort: "high" },
    sol_review: { model: "sol", reasoning_effort: "high" },
  };
  const expected = {
    runId: receipt.run_id,
    revisionRound: 1,
    revisionRequestSha256: receipt.revision_request_sha256,
    specSetSha256: receipt.spec_set_sha256,
    previousResultBundleSha256: receipt.previous_result_bundle_sha256,
    previousResultReceiptSha256: receipt.previous_result_receipt_sha256,
    previousVerdictSha256: receipt.previous_verdict_sha256,
    previousPublishedCommitSha: receipt.previous_published_commit_sha,
    previousPrHeadSha: receipt.previous_pr_head_sha,
    pullRequestNumber: 42,
    branchName: "codex/feature",
    baseBranch: "main",
    worktreePath: "/trusted/worktree",
    implementer: { model: "terra", reasoningEffort: "high" },
    terra: { model: "terra", reasoningEffort: "high" },
    sol: { model: "sol", reasoningEffort: "high" },
  };
  return { receipt, expected };
}

for (const state of ["IMPLEMENTING", "VERIFYING", "TERRA_REVIEWING", "SOL_REVIEWING"] as const) {
  test(`v0.2 revision adoption blocks ambiguous persisted ${state} provider boundary`, () => {
    const { receipt, expected } = fixture(state);
    assert.throws(
      () => assertRevisionReceiptAuthority(receipt, expected),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_AMBIGUOUS_RECOVERY",
    );
  });
}

test("v0.2 retryable receipt cannot smuggle an ambiguous provider checkpoint back into execution", () => {
  const { receipt, expected } = fixture("RETRYABLE", "TERRA_REVIEWING");
  assert.throws(
    () => assertRevisionReceiptAuthority(receipt, expected),
    (error: unknown) => error instanceof RevisionError && error.code === "REVISION_AMBIGUOUS_RECOVERY",
  );
});

test("v0.2 safe revision checkpoints remain adoptable", () => {
  for (const state of ["READY_TO_REVISE", "POLICY_CHECKING", "READY_FOR_PUBLISH", "COMMITTED", "PUSHED", "RESULT_READY"] as const) {
    const { receipt, expected } = fixture(state);
    assert.doesNotThrow(() => assertRevisionReceiptAuthority(receipt, expected), state);
  }
});
