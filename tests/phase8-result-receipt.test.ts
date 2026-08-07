import test from "node:test";
import assert from "node:assert/strict";
import { assertResultBundleReceipt } from "../src/result-bundle/result-bundle-store.js";
import { ResultBundleError, type ResultBundleReceipt } from "../src/result-bundle/contracts.js";

function validRevisionReceipt(): ResultBundleReceipt {
  return {
    result_bundle_version: "1.2",
    input_kind: "revision",
    revision_round: 1,
    run_id: `TASK:${"1".repeat(64)}`,
    state: "READY_FOR_WEB_REVIEW",
    input_digest_sha256: "2".repeat(64),
    execution_receipt_sha256: "3".repeat(64),
    git_publish_receipt_sha256: "4".repeat(64),
    draft_pr_receipt_sha256: "5".repeat(64),
    revision_evidence_sha256: "6".repeat(64),
    revision_request_sha256: "7".repeat(64),
    previous_result_bundle_sha256: "8".repeat(64),
    previous_result_receipt_sha256: "9".repeat(64),
    previous_verdict_sha256: "a".repeat(64),
    previous_published_commit_sha: "b".repeat(40),
    previous_pr_head_sha: "b".repeat(40),
    accepted_bundle_tree_sha256: "c".repeat(64),
    change_set_sha256: "d".repeat(64),
    base_commit: "e".repeat(40),
    published_commit_sha: "f".repeat(40),
    remote_branch_sha: "f".repeat(40),
    pull_request: {
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "open",
      draft: true,
      head_branch: "codex/feature",
      head_sha: "f".repeat(40),
      base_branch: "main",
      title_sha256: "1".repeat(64),
    },
    archive_relative_path: "handoff/runs/TASK/sha/revisions/01/result.zip",
    archive_sha256: "2".repeat(64),
    archive_size_bytes: 1024,
    entry_count: 20,
    uncompressed_size_bytes: 2048,
    manifest_sha256: "3".repeat(64),
    warnings: [],
    created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z",
    built_at: "2026-08-07T00:00:00.000Z",
    verified_at: "2026-08-07T00:00:00.000Z",
    ready_at: "2026-08-07T00:00:00.000Z",
    spec_set_sha256: "4".repeat(64),
    review_contract_sha256: "5".repeat(64),
    review_policy_sha256: "6".repeat(64),
    verdict_schema_sha256: "7".repeat(64),
    revision_request_schema_sha256: "8".repeat(64),
    reviewed_entry_set_sha256: "9".repeat(64),
  };
}

test("P8-RB-001: v1.2 revision receipt requires the complete immutable chain", () => {
  const receipt = validRevisionReceipt();
  assert.doesNotThrow(() => assertResultBundleReceipt(receipt));
  for (const field of [
    "revision_evidence_sha256",
    "revision_request_sha256",
    "previous_result_bundle_sha256",
    "previous_result_receipt_sha256",
    "previous_verdict_sha256",
    "previous_published_commit_sha",
    "previous_pr_head_sha",
  ] as const) {
    const tampered = { ...receipt, [field]: null };
    assert.throws(
      () => assertResultBundleReceipt(tampered),
      (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_RECEIPT_INVALID"
    );
  }
});

test("P8-RB-002: v1.2 cannot masquerade as initial input or exceed revision budget", () => {
  assert.throws(
    () => assertResultBundleReceipt({ ...validRevisionReceipt(), input_kind: "initial" }),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_RECEIPT_INVALID"
  );
  assert.throws(
    () => assertResultBundleReceipt({ ...validRevisionReceipt(), revision_round: 4 }),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_RECEIPT_INVALID"
  );
});

test("P8-RB-003: Phase 6 v1.1 remains backward-compatible", () => {
  const revision = validRevisionReceipt();
  const initial: ResultBundleReceipt = {
    ...revision,
    result_bundle_version: "1.1",
    input_kind: "initial",
    revision_round: null,
    revision_evidence_sha256: undefined,
    revision_request_sha256: undefined,
    previous_result_bundle_sha256: undefined,
    previous_result_receipt_sha256: undefined,
    previous_verdict_sha256: undefined,
    previous_published_commit_sha: undefined,
    previous_pr_head_sha: undefined,
  };
  assert.doesNotThrow(() => assertResultBundleReceipt(initial));
});
