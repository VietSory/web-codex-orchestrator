import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitRunner } from "../src/git/git-runner.js";
import { attestRevisionGitBoundary, calculateApprovedRevisionSnapshot, publishRevision } from "../src/revision/revision-git.js";
import { attestAcceptedBundleAuthority, assertRevisionReceiptAuthority } from "../src/revision/revision-authority.js";
import { RevisionError } from "../src/revision/contracts.js";
import { loadAndVerifyResultBundle } from "../src/web-review/result-bundle-review-reader.js";
import { validateReviewHistory } from "../src/web-review/review-history.js";
import { prepareReviewRoundDirectory, resolveReviewRoundPaths } from "../src/web-review/web-review-paths.js";
import { writeWebReviewReceipt } from "../src/web-review/web-review-store.js";
import { WebReviewError, type WebReviewReceipt } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, TEST_RUN_ID, TEST_ARCHIVE_SHA, TEST_TASK_ID } from "./helpers/phase7-fixtures.js";

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");
}
function lexicalCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
async function acceptedTree(root: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for (const name of (await fs.readdir(root)).sort(lexicalCompare)) {
    const full = path.join(root, name);
    const stat = await fs.lstat(full);
    if (!stat.isFile()) continue;
    hash.update(name);
    hash.update(await fs.readFile(full));
  }
  return hash.digest("hex");
}
async function git(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function gitFixture(): Promise<{ root: string; repo: string; remote: string; rogue: string; runner: GitRunner; previous: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-maint-git-")));
  const remote = path.join(root, "remote.git");
  const rogue = path.join(root, "rogue.git");
  const repo = path.join(root, "repo");
  await fs.mkdir(remote); await fs.mkdir(rogue); await fs.mkdir(repo);
  const runner = new GitRunner();
  await git(runner, remote, ["init", "--bare"]);
  await git(runner, rogue, ["init", "--bare"]);
  await git(runner, repo, ["init"]);
  await git(runner, repo, ["config", "user.name", "Maintainer Test"]);
  await git(runner, repo, ["config", "user.email", "maintainer@example.invalid"]);
  await fs.writeFile(path.join(repo, "app.txt"), "v1\n");
  await git(runner, repo, ["add", "app.txt"]);
  await git(runner, repo, ["commit", "-m", "initial"]);
  await git(runner, repo, ["branch", "-M", "codex/feature"]);
  await git(runner, repo, ["remote", "add", "origin", remote]);
  await git(runner, repo, ["push", "-u", "origin", "codex/feature"]);
  return { root, repo: await fs.realpath(repo), remote: await fs.realpath(remote), rogue: await fs.realpath(rogue), runner, previous: await git(runner, repo, ["rev-parse", "HEAD"]) };
}

test("P8-MAINT-001: changed remote URL is rejected before any ls-remote or push", async () => {
  const f = await gitFixture();
  try {
    const boundary = await attestRevisionGitBoundary({ worktreePath: f.repo, branchName: "codex/feature", remoteName: "origin", expectedRemoteUrls: [f.remote], previousHeadSha: f.previous, runner: f.runner });
    await fs.writeFile(path.join(f.repo, "app.txt"), "approved\n");
    const snapshot = await calculateApprovedRevisionSnapshot({ runner: f.runner, worktreePath: f.repo, approvedPaths: ["app.txt"] });
    await git(f.runner, f.repo, ["remote", "set-url", "origin", f.rogue]);
    const commands: string[][] = [];
    class RecordingRunner extends GitRunner {
      override async run(args: readonly string[], cwd: string) { commands.push([...args]); return super.run(args, cwd); }
    }
    await assert.rejects(
      () => publishRevision({ ...boundary, approvedPaths: ["app.txt"], approvedSnapshotSha256: snapshot, commitMessage: "revision" }, new RecordingRunner()),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_REMOTE_DRIFT"
    );
    assert.equal(commands.some((args) => args[0] === "ls-remote" || args[0] === "push"), false);
    assert.equal(await git(f.runner, f.repo, ["rev-parse", "HEAD"]), f.previous);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("P8-MAINT-002: recomputing checksums cannot authorize a mutated accepted Task Bundle", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-maint-bundle-")));
  try {
    const manifest = path.join(root, "manifest.json");
    await fs.writeFile(manifest, "original\n");
    await fs.writeFile(path.join(root, "checksums.json"), JSON.stringify({ algorithm: "sha256", files: { "manifest.json": sha256("original\n") } }, null, 2));
    const sealedTree = await acceptedTree(root);
    assert.equal(await attestAcceptedBundleAuthority(root, sealedTree), sealedTree);

    await fs.writeFile(manifest, "tampered before revise\n");
    await fs.writeFile(path.join(root, "checksums.json"), JSON.stringify({ algorithm: "sha256", files: { "manifest.json": sha256("tampered before revise\n") } }, null, 2));
    await assert.rejects(
      () => attestAcceptedBundleAuthority(root, sealedTree),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_BUNDLE_MUTATED"
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("P8-MAINT-003: mutable revision checkpoint cannot redefine canonical worktree or history", () => {
  const receipt: any = {
    run_id: "TASK:" + "1".repeat(64), revision_round: 1, revision_request_sha256: "2".repeat(64), spec_set_sha256: "3".repeat(64),
    previous_result_bundle_sha256: "4".repeat(64), previous_result_receipt_sha256: "5".repeat(64), previous_verdict_sha256: "6".repeat(64),
    previous_published_commit_sha: "7".repeat(40), previous_pr_head_sha: "8".repeat(40), pull_request_number: 42,
    branch_name: "codex/feature", base_branch: "main", worktree_path: "/trusted/worktree",
    implementer: { model: "terra", reasoning_effort: "high" }, terra_review: { model: "terra", reasoning_effort: "high" }, sol_review: { model: "sol", reasoning_effort: "high" },
  };
  const expected = {
    runId: receipt.run_id, revisionRound: 1, revisionRequestSha256: receipt.revision_request_sha256, specSetSha256: receipt.spec_set_sha256,
    previousResultBundleSha256: receipt.previous_result_bundle_sha256, previousResultReceiptSha256: receipt.previous_result_receipt_sha256,
    previousVerdictSha256: receipt.previous_verdict_sha256, previousPublishedCommitSha: receipt.previous_published_commit_sha,
    previousPrHeadSha: receipt.previous_pr_head_sha, pullRequestNumber: 42, branchName: "codex/feature", baseBranch: "main", worktreePath: "/trusted/worktree",
    implementer: { model: "terra", reasoningEffort: "high" }, terra: { model: "terra", reasoningEffort: "high" }, sol: { model: "sol", reasoningEffort: "high" },
  };
  assert.doesNotThrow(() => assertRevisionReceiptAuthority(receipt, expected));
  assert.throws(
    () => assertRevisionReceiptAuthority({ ...receipt, worktree_path: "/other/worktree", previous_verdict_sha256: "9".repeat(64) }, expected),
    (error: unknown) => error instanceof RevisionError && error.code === "REVISION_STATE_INVALID" && error.message.includes("worktree_path") && error.message.includes("previous_verdict_sha256")
  );
});

test("P8-MAINT-004: review round 2 cannot accept an initial v1.1 Result Bundle placed in the revision directory", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-maint-round-")));
  try {
    const fixture = await createPhase6BundleFixture(root);
    const revisionDir = path.join(fixture.stateDirectory, "handoff", "runs", TEST_TASK_ID, TEST_ARCHIVE_SHA, "revisions", "01");
    await fs.mkdir(revisionDir, { recursive: true });
    await fs.copyFile(fixture.receiptPath, path.join(revisionDir, "result-bundle.json"));
    await assert.rejects(
      () => loadAndVerifyResultBundle(fixture.stateDirectory, TEST_RUN_ID, 2),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_RESULT_BUNDLE_INVALID" && error.message.includes("v1.2")
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

function previousReviewReceipt(state: string): WebReviewReceipt {
  const h = (c: string) => c.repeat(64);
  const c = (x: string) => x.repeat(40);
  return {
    phase_version: "1.1", run_id: TEST_RUN_ID, review_mode: "INITIAL", review_round: 1, state: "REVISION_REQUESTED",
    phase6_receipt_sha256: h("1"), result_bundle_sha256: h("2"), manifest_sha256: h("3"), reviewed_entry_set_sha256: h("4"), spec_set_sha256: h("5"),
    verdict_sha256: h("6"), published_commit_sha: c("a"), pull_request_number: 101, observed_head_sha: c("a"), fresh_attested_head_sha: c("a"), fresh_attested_base_branch: "main",
    previous_result_bundle_sha256: null, previous_verdict_sha256: null, previous_published_commit_sha: null, previous_pr_head_sha: null, revision_request_sha256: h("7"), decision_event_sha256: h("8"), action: "NO_USER_MERGE_PROMPT",
    artifact_paths: { verdict: "verdict.json", receipt: path.relative(state, resolveReviewRoundPaths(state, TEST_RUN_ID, 1).receiptPath), decision_event: "decision.json", revision_request: "revision.json", lock: "lock" },
    warnings: [], errors: [], created_at: "2026-08-07T00:00:00.000Z", updated_at: "2026-08-07T00:00:00.000Z", validated_at: "2026-08-07T00:00:00.000Z", completed_at: "2026-08-07T00:00:00.000Z",
  };
}

test("P8-MAINT-005: Phase 7 rejects a v1.2 bundle that is not chained to the exact previous terminal review", async () => {
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-maint-chain-")));
  try {
    const paths = resolveReviewRoundPaths(state, TEST_RUN_ID, 1);
    await prepareReviewRoundDirectory(state, paths.roundDir);
    const previous = previousReviewReceipt(state);
    await writeWebReviewReceipt(paths.receiptPath, previous);
    const currentBundle: any = {
      receipt: {
        result_bundle_version: "1.2", input_kind: "revision", revision_round: 1,
        previous_result_bundle_sha256: previous.result_bundle_sha256,
        previous_result_receipt_sha256: previous.phase6_receipt_sha256,
        previous_verdict_sha256: "f".repeat(64),
        revision_request_sha256: previous.revision_request_sha256,
        previous_published_commit_sha: previous.published_commit_sha,
        previous_pr_head_sha: previous.fresh_attested_head_sha,
        spec_set_sha256: previous.spec_set_sha256,
        pull_request: { number: previous.pull_request_number },
      },
    };
    const verdict: any = {
      review_mode: "REVISION", previous_result_bundle_sha256: previous.result_bundle_sha256, previous_verdict_sha256: previous.verdict_sha256,
      revision_request_sha256: previous.revision_request_sha256, previous_published_commit_sha: previous.published_commit_sha,
      spec_set_sha256: previous.spec_set_sha256, pull_request_number: previous.pull_request_number,
    };
    await assert.rejects(
      () => validateReviewHistory(state, TEST_RUN_ID, 2, verdict, currentBundle),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_HISTORY_INVALID" && error.message.includes("previous_verdict_sha256")
    );
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});
