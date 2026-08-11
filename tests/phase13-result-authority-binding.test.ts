import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../src/result-bundle/canonical-json.js";
import { canonicalGitPublishReceiptDigest } from "../src/publish/receipt-digest.js";
import { initialResultBoundToSelectedExecutor, webReviewBoundToCurrentResult } from "../src/orchestration/snapshot-reader.js";

const RUN_ID = `TASK-P13-BIND:${"a".repeat(64)}`;
const DIGEST = "d".repeat(64);
const COMMIT = "3".repeat(40);
const BASE = "1".repeat(40);
const hash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function authorities() {
  const executor = {
    executor_version: "1.0", run_id: RUN_ID, task_id: "TASK-P13-BIND", task_bundle_sha256: "a".repeat(64),
    artifact_sha256: "b".repeat(64), pack_id: "pack-1", state: "READY_FOR_PUBLISH", repository_id: "repo",
    base_branch: "main", base_commit: BASE, base_tree_sha: "2".repeat(40), worktree_path: "/tmp/worktree",
    registration_manifest_sha256: "c".repeat(64), operations: [], change_set_digest: DIGEST,
    verification: { rounds: 1, passed: true, change_set_digest: DIGEST, evidence_sha256: "4".repeat(64) },
    terra_review: { rounds: 1, verdict: "APPROVE", change_set_digest: DIGEST, evidence_sha256: "5".repeat(64) },
    sol_review: { rounds: 1, verdict: "APPROVE", change_set_digest: DIGEST, evidence_sha256: "6".repeat(64) },
    errors: [], created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:01.000Z",
  } as any;
  const executionSha = hash(canonicalJsonBuffer(executor));
  const publish = {
    publish_version: "1.1", run_id: RUN_ID, state: "PUSHED", base_commit: BASE, branch_name: "codex/task",
    remote_name: "origin", allowed_remote_url: "https://github.com/owner/repo", change_set_sha256: DIGEST,
    expected_paths: ["src/a.ts"], approved_snapshot_sha256: DIGEST, commit_sha: COMMIT, remote_branch_sha: COMMIT,
    created_at: "2026-08-09T00:00:02.000Z", updated_at: "2026-08-09T00:00:02.000Z",
    committed_at: "2026-08-09T00:00:02.000Z", pushed_at: "2026-08-09T00:00:02.000Z",
  } as any;
  const publishBytes = Buffer.from(`${JSON.stringify(publish, null, 2)}\n`, "utf8");
  const draft = {
    receipt_version: "1.0", run_id: RUN_ID, state: "OPEN", repository_owner: "owner", repository_name: "repo",
    base_branch: "main", head_branch: "codex/task", expected_head_sha: COMMIT,
    git_publish_receipt_sha256: canonicalGitPublishReceiptDigest(publish), request_sha256: "8".repeat(64), title: "Test",
    body_sha256: "9".repeat(64), draft_required: true, create_post_attempted: true, pull_number: 42,
    pull_url: "https://github.com/owner/repo/pull/42", observed_head_sha: COMMIT, observed_base_branch: "main",
    observed_state: "open", observed_draft: true, conflict_reason: null,
    created_at: "2026-08-09T00:00:03.000Z", updated_at: "2026-08-09T00:00:03.000Z",
    create_attempted_at: "2026-08-09T00:00:03.000Z", opened_at: "2026-08-09T00:00:03.000Z", conflict_at: null,
  } as any;
  const draftBytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, "utf8");
  const publishSnapshot = { receipt: publish, bytes: publishBytes };
  const draftSnapshot = { receipt: draft, bytes: draftBytes };
  const result = {
    result_bundle_version: "1.1", run_id: RUN_ID, state: "READY_FOR_WEB_REVIEW",
    execution_receipt_sha256: executionSha, git_publish_receipt_sha256: hash(publishBytes), draft_pr_receipt_sha256: hash(draftBytes),
    change_set_sha256: DIGEST, base_commit: BASE, published_commit_sha: COMMIT, remote_branch_sha: COMMIT,
    archive_sha256: "e".repeat(64),
    pull_request: { number: 42, url: "https://github.com/owner/repo/pull/42", state: "open", draft: true, head_branch: "codex/task", head_sha: COMMIT, base_branch: "main", title_sha256: "f".repeat(64) },
  } as any;
  return { executor, publishSnapshot, draftSnapshot, result };
}

test("P13-BIND-001 exact selected executor/publish/Draft/result authority is ready", () => {
  const { executor, publishSnapshot, draftSnapshot, result } = authorities();
  assert.equal(initialResultBoundToSelectedExecutor(RUN_ID, executor, publishSnapshot, draftSnapshot, result), true);
});

test("P13-BIND-002 stale executor receipt identity cannot make the planner quiescent", () => {
  const { executor, publishSnapshot, draftSnapshot, result } = authorities();
  assert.equal(initialResultBoundToSelectedExecutor(RUN_ID, executor, publishSnapshot, draftSnapshot, { ...result, execution_receipt_sha256: "0".repeat(64) }), false);
});

test("P13-BIND-003 stale change-set digest cannot make the planner quiescent", () => {
  const { executor, publishSnapshot, draftSnapshot, result } = authorities();
  assert.equal(initialResultBoundToSelectedExecutor(RUN_ID, executor, publishSnapshot, draftSnapshot, { ...result, change_set_sha256: "0".repeat(64) }), false);
});

test("P13-BIND-004 stale publish head cannot make the planner quiescent", () => {
  const { executor, publishSnapshot, draftSnapshot, result } = authorities();
  const stalePublish = { ...publishSnapshot, receipt: { ...publishSnapshot.receipt, commit_sha: "4".repeat(40), remote_branch_sha: "4".repeat(40) } };
  assert.equal(initialResultBoundToSelectedExecutor(RUN_ID, executor, stalePublish, draftSnapshot, result), false);
});

test("P13-BIND-005 wrong Draft PR identity cannot make the planner quiescent", () => {
  const { executor, publishSnapshot, draftSnapshot, result } = authorities();
  const staleDraft = { ...draftSnapshot, receipt: { ...draftSnapshot.receipt, pull_number: 43 } };
  assert.equal(initialResultBoundToSelectedExecutor(RUN_ID, executor, publishSnapshot, staleDraft, result), false);
});

test("P13-BIND-006 changed Phase 5 receipt bytes cannot make the planner quiescent", () => {
  const { executor, publishSnapshot, draftSnapshot, result } = authorities();
  const staleBytes = { ...publishSnapshot, bytes: Buffer.concat([publishSnapshot.bytes, Buffer.from(" ")]) };
  assert.equal(initialResultBoundToSelectedExecutor(RUN_ID, executor, staleBytes, draftSnapshot, result), false);
});

test("P13-BIND-007 Draft PR bound to a different publish receipt cannot make the planner quiescent", () => {
  const { executor, publishSnapshot, draftSnapshot, result } = authorities();
  const staleDraft = { ...draftSnapshot, receipt: { ...draftSnapshot.receipt, git_publish_receipt_sha256: "0".repeat(64) } };
  assert.equal(initialResultBoundToSelectedExecutor(RUN_ID, executor, publishSnapshot, staleDraft, result), false);
});

test("P13-BIND-008 Web decision binds only the exact current Result generation", () => {
  const { result } = authorities();
  const review = { run_id: RUN_ID, result_bundle_sha256: result.archive_sha256, published_commit_sha: COMMIT, pull_request_number: 42 } as any;
  assert.equal(webReviewBoundToCurrentResult(review, result), true);
  assert.equal(webReviewBoundToCurrentResult(review, { ...result, archive_sha256: "0".repeat(64) }), false);
  assert.equal(webReviewBoundToCurrentResult(review, { ...result, published_commit_sha: "4".repeat(40) }), false);
  assert.equal(webReviewBoundToCurrentResult(review, { ...result, pull_request: { ...result.pull_request, number: 43 } }), false);
  assert.equal(webReviewBoundToCurrentResult(review, { ...result, state: "FAILED" }), false);
});