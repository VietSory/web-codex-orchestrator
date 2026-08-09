import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitPublishReceipt } from "../src/publish/contracts.js";
import { writeGitPublishReceipt } from "../src/publish/publish-store.js";
import { canonicalGitPublishReceiptDigest } from "../src/publish/receipt-digest.js";
import type { DraftPullRequestReceipt } from "../src/pull-request/contracts.js";
import { writeDraftPullRequestReceipt } from "../src/pull-request/draft-pr-store.js";
import type { ResultBundleReceipt } from "../src/result-bundle/contracts.js";
import { ResultBundleError } from "../src/result-bundle/contracts.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";
import { reattestReadyResultBundleAuthority } from "../src/result-bundle/ready-result-attestation.js";

const archiveSha = "a".repeat(64);
const taskId = "READY-RESULT";
const runId = `${taskId}:${archiveSha}`;
const commitSha = "b".repeat(40);
const baseCommit = "c".repeat(40);
const changeSet = "d".repeat(64);
const title = "Ready result attestation";
const titleSha = crypto.createHash("sha256").update(title, "utf8").digest("hex");
const remoteUrl = "https://github.com/example/my.repo.git";
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function publishReceipt(): GitPublishReceipt {
  return {
    publish_version: "1.1", run_id: runId, state: "PUSHED", base_commit: baseCommit,
    branch_name: "codex/ready-result", remote_name: "origin", allowed_remote_url: remoteUrl,
    change_set_sha256: changeSet, expected_paths: ["src/example.ts"], approved_snapshot_sha256: "e".repeat(64),
    commit_sha: commitSha, remote_branch_sha: commitSha, created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T00:00:01.000Z", committed_at: "2026-08-09T00:00:00.500Z", pushed_at: "2026-08-09T00:00:01.000Z",
  };
}

function draftReceipt(overrides: Partial<DraftPullRequestReceipt> = {}): DraftPullRequestReceipt {
  return {
    receipt_version: "1.0", run_id: runId, state: "OPEN", repository_owner: "example", repository_name: "my.repo",
    base_branch: "main", head_branch: "codex/ready-result", expected_head_sha: commitSha,
    git_publish_receipt_sha256: canonicalGitPublishReceiptDigest(publishReceipt()), request_sha256: "1".repeat(64), title, body_sha256: "2".repeat(64),
    draft_required: true, create_post_attempted: true, pull_number: 42, pull_url: "https://github.com/example/my.repo/pull/42",
    observed_head_sha: commitSha, observed_base_branch: "main", observed_state: "open", observed_draft: true,
    conflict_reason: null, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:01.000Z",
    create_attempted_at: "2026-08-09T00:00:00.500Z", opened_at: "2026-08-09T00:00:01.000Z", conflict_at: null,
    ...overrides,
  };
}

function resultReceipt(publishSha: string, draftSha: string): ResultBundleReceipt {
  return {
    result_bundle_version: "1.1", run_id: runId, state: "READY_FOR_WEB_REVIEW", input_digest_sha256: "3".repeat(64),
    execution_receipt_sha256: "4".repeat(64), git_publish_receipt_sha256: publishSha, draft_pr_receipt_sha256: draftSha,
    accepted_bundle_tree_sha256: "7".repeat(64), change_set_sha256: changeSet, base_commit: baseCommit,
    published_commit_sha: commitSha, remote_branch_sha: commitSha,
    pull_request: {
      number: 42, url: "https://github.com/example/my.repo/pull/42", state: "open", draft: true,
      head_branch: "codex/ready-result", head_sha: commitSha, base_branch: "main", title_sha256: titleSha,
    },
    archive_relative_path: "handoff/result.zip", archive_sha256: "8".repeat(64), archive_size_bytes: 1024,
    entry_count: 10, uncompressed_size_bytes: 2048, manifest_sha256: "9".repeat(64), warnings: [],
    created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:01.000Z",
    built_at: "2026-08-09T00:00:01.000Z", verified_at: "2026-08-09T00:00:01.000Z", ready_at: "2026-08-09T00:00:01.000Z",
    spec_set_sha256: "a".repeat(64), review_contract_sha256: "b".repeat(64), review_policy_sha256: "c".repeat(64),
    verdict_schema_sha256: "d".repeat(64), revision_request_schema_sha256: "e".repeat(64), reviewed_entry_set_sha256: "f".repeat(64),
  };
}

class FakeGitHub implements GitHubAttestationClient {
  observedOwner = "";
  observedRepo = "";
  response: Record<string, unknown> = freshPr();
  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<unknown> {
    this.observedOwner = owner;
    this.observedRepo = repo;
    assert.equal(prNumber, 42);
    return this.response;
  }
}

function freshPr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42, html_url: "https://github.com/example/my.repo/pull/42", state: "open", draft: true,
    merged: false, merged_at: null, title, head: { ref: "codex/ready-result", sha: commitSha }, base: { ref: "main" }, ...overrides,
  };
}

async function fixture(t: test.TestContext, draft = draftReceipt()) {
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-ready-result-attest-")));
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  const p5aPath = path.join(state, "runs", taskId, archiveSha, "execution", "publish", "git-publish.json");
  const p5bPath = path.join(state, "publish", "github-draft-pr.json");
  await writeGitPublishReceipt(p5aPath, publishReceipt());
  await writeDraftPullRequestReceipt(p5bPath, draft);
  const receipt = resultReceipt(sha256(await fs.readFile(p5aPath)), sha256(await fs.readFile(p5bPath)));
  return { state, p5aPath, p5bPath, receipt };
}

test("READY-RESULT-001 fresh retry re-attests the exact dotted GitHub repository identity", async (t) => {
  const { state, receipt } = await fixture(t);
  const github = new FakeGitHub();
  await reattestReadyResultBundleAuthority({ stateDirectory: state, runId, receipt, githubClient: github });
  assert.equal(github.observedOwner, "example");
  assert.equal(github.observedRepo, "my.repo");
});

test("READY-RESULT-002 fresh retry rejects a PR that is no longer Draft", async (t) => {
  const { state, receipt } = await fixture(t);
  const github = new FakeGitHub();
  github.response = freshPr({ draft: false });
  await assert.rejects(
    () => reattestReadyResultBundleAuthority({ stateDirectory: state, runId, receipt, githubClient: github }),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_PR_IDENTITY_MISMATCH",
  );
});

test("READY-RESULT-003 fresh retry rejects head drift instead of adopting stale handoff authority", async (t) => {
  const { state, receipt } = await fixture(t);
  const github = new FakeGitHub();
  github.response = freshPr({ head: { ref: "codex/ready-result", sha: "0".repeat(40) } });
  await assert.rejects(
    () => reattestReadyResultBundleAuthority({ stateDirectory: state, runId, receipt, githubClient: github }),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_PR_IDENTITY_MISMATCH",
  );
});

test("READY-RESULT-004 persisted repository identity mismatch fails before GitHub API access", async (t) => {
  const { state, receipt } = await fixture(t, draftReceipt({ repository_name: "other.repo" }));
  const github = new FakeGitHub();
  await assert.rejects(
    () => reattestReadyResultBundleAuthority({ stateDirectory: state, runId, receipt, githubClient: github }),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_PR_RECEIPT_INCONSISTENT",
  );
  assert.equal(github.observedRepo, "");
});

test("READY-RESULT-005 exact receipt-byte drift fails before GitHub API access", async (t) => {
  const { state, p5aPath, receipt } = await fixture(t);
  const mutated = publishReceipt();
  mutated.updated_at = "2026-08-09T00:00:02.000Z";
  await writeGitPublishReceipt(p5aPath, mutated);
  const github = new FakeGitHub();
  await assert.rejects(
    () => reattestReadyResultBundleAuthority({ stateDirectory: state, runId, receipt, githubClient: github }),
    (error: unknown) => error instanceof ResultBundleError && (error.code === "RESULT_PR_RECEIPT_INCONSISTENT" || error.code === "RESULT_RECEIPT_INVALID"),
  );
  assert.equal(github.observedRepo, "");
});
