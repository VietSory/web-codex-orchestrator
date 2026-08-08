import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executionPaths, readExecutionReceipt } from "../src/execution/execution-store.js";
import { packageResultForRun } from "../src/orchestration/package-result.js";
import { readDraftPullRequestReceipt } from "../src/pull-request/draft-pr-store.js";
import { readGitPublishReceipt } from "../src/publish/publish-store.js";
import { resultBundlePaths } from "../src/result-bundle/result-bundle-paths.js";
import type { ResultBundleReceipt } from "../src/result-bundle/contracts.js";

const TASK_ID = "TASK-P13-PROD";
const TASK_BUNDLE_SHA256 = "a".repeat(64);
const ARTIFACT_SHA256 = "b".repeat(64);
const DIGEST = "d".repeat(64);
const BASE = "1".repeat(40);
const COMMIT = "2".repeat(40);
const RUN_ID = `${TASK_ID}:${TASK_BUNDLE_SHA256}`;
const NOW = "2026-08-08T00:00:00.000Z";

function publishReceipt() {
  return {
    publish_version: "1.1",
    run_id: RUN_ID,
    state: "PUSHED",
    base_commit: BASE,
    branch_name: "codex/p13-prod",
    remote_name: "origin",
    allowed_remote_url: "https://github.com/example/repo",
    change_set_sha256: DIGEST,
    expected_paths: ["src/a.ts"],
    approved_snapshot_sha256: "e".repeat(64),
    commit_sha: COMMIT,
    remote_branch_sha: COMMIT,
    created_at: NOW,
    updated_at: NOW,
    committed_at: NOW,
    pushed_at: NOW,
  };
}

function draftReceipt() {
  return {
    receipt_version: "1.0",
    run_id: RUN_ID,
    state: "OPEN",
    repository_owner: "example",
    repository_name: "repo",
    base_branch: "main",
    head_branch: "codex/p13-prod",
    expected_head_sha: COMMIT,
    git_publish_receipt_sha256: "f".repeat(64),
    request_sha256: "3".repeat(64),
    title: "P13 production adapter",
    body_sha256: "4".repeat(64),
    draft_required: true,
    create_post_attempted: true,
    pull_number: 42,
    pull_url: "https://github.com/example/repo/pull/42",
    observed_head_sha: COMMIT,
    observed_base_branch: "main",
    observed_state: "open",
    observed_draft: true,
    conflict_reason: null,
    created_at: NOW,
    updated_at: NOW,
    create_attempted_at: NOW,
    opened_at: NOW,
    conflict_at: null,
  };
}

function fakeReady(executorDirectory: string) {
  return {
    executorDirectory,
    changeSetDigest: DIGEST,
    changedPaths: ["src/a.ts"],
    receipt: {
      executor_version: "1.0",
      run_id: RUN_ID,
      task_id: TASK_ID,
      task_bundle_sha256: TASK_BUNDLE_SHA256,
      artifact_sha256: ARTIFACT_SHA256,
      pack_id: "PACK-P13",
      state: "READY_FOR_PUBLISH",
      repository_id: "repo",
      base_branch: "main",
      base_commit: BASE,
      base_tree_sha: "5".repeat(40),
      worktree_path: "/tmp/p13-worktree",
      registration_manifest_sha256: "6".repeat(64),
      operations: [],
      change_set_digest: DIGEST,
      verification: { rounds: 1, passed: true, change_set_digest: DIGEST, evidence_sha256: "7".repeat(64) },
      terra_review: { rounds: 1, verdict: "APPROVE", change_set_digest: DIGEST, evidence_sha256: "8".repeat(64) },
      sol_review: { rounds: 1, verdict: "APPROVE", change_set_digest: DIGEST, evidence_sha256: "9".repeat(64) },
      errors: [],
      created_at: NOW,
      updated_at: NOW,
    },
    source: {
      trusted: {
        runReceipt: {
          run_id: RUN_ID,
          task_id: TASK_ID,
          archive_sha256: TASK_BUNDLE_SHA256,
          repository_id: "repo",
          base_branch: "main",
          base_commit: BASE,
          branch_name: "codex/p13-prod",
          worktree_path: "/tmp/p13-worktree",
          accepted_bundle_path: "/tmp/p13-bundle",
        },
      },
    },
  };
}

test("P13-PROD-001 production adapter projects executor-scoped P10/P11/P12 state into the Phase 6 reader topology", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-p13-prod-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const executorDirectory = path.join(root, "executor", "runs", TASK_ID, TASK_BUNDLE_SHA256, "artifacts", ARTIFACT_SHA256);
  await fs.mkdir(path.join(executorDirectory, "publish"), { recursive: true });
  await fs.writeFile(path.join(executorDirectory, "executor-receipt.json"), JSON.stringify({ source: "p10" }));
  await fs.writeFile(path.join(executorDirectory, "publish", "git-publish.json"), JSON.stringify(publishReceipt()));
  await fs.writeFile(path.join(executorDirectory, "publish", "github-draft-pr.json"), JSON.stringify(draftReceipt()));

  const tokenKey = "WCO_P13_TEST_GITHUB_TOKEN";
  const previousToken = process.env[tokenKey];
  process.env[tokenKey] = "p13-test-token-value";
  t.after(() => {
    if (previousToken === undefined) delete process.env[tokenKey];
    else process.env[tokenKey] = previousToken;
  });

  let observedCompatibilityRoot = "";
  const receipt = await packageResultForRun(
    { runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json") },
    {
      loadConfig: async () => ({
        github_pull_request: { provider: "github.com", authentication: { mode: "https_token", token_environment_key: tokenKey } },
        agents: {
          internal_reviewer: { model: "terra-test", reasoning_effort: "high" },
          final_reviewer: { model: "sol-test", reasoning_effort: "high" },
        },
      } as never),
      readSelectedArtifact: async () => ({ artifact_sha256: ARTIFACT_SHA256 } as never),
      attestReadyExecutor: async () => fakeReady(executorDirectory) as never,
      packageBundle: async (options) => {
        observedCompatibilityRoot = options.stateDirectory;
        assert.notEqual(path.resolve(options.stateDirectory), path.resolve(root));
        const compatExecution = await readExecutionReceipt(options.stateDirectory, TASK_ID, TASK_BUNDLE_SHA256);
        assert.equal(compatExecution?.run_id, RUN_ID);
        assert.equal(compatExecution?.state, "READY_FOR_PUBLISH");
        assert.equal(compatExecution?.change_set_sha256, DIGEST);
        assert.equal(compatExecution?.base_commit, BASE);
        assert.equal(compatExecution?.branch_name, "codex/p13-prod");
        assert.equal(compatExecution?.internal_reviewer.verdict, "APPROVE");
        assert.equal(compatExecution?.final_reviewer.verdict, "APPROVE");

        const compatPaths = executionPaths(options.stateDirectory, TASK_ID, TASK_BUNDLE_SHA256);
        const publish = await readGitPublishReceipt(path.join(compatPaths.directory, "publish", "git-publish.json"));
        const draft = await readDraftPullRequestReceipt(path.join(options.stateDirectory, "publish", "github-draft-pr.json"));
        assert.equal(publish?.commit_sha, COMMIT);
        assert.equal(draft?.pull_number, 42);

        const resultPaths = resultBundlePaths(options.stateDirectory, TASK_ID, TASK_BUNDLE_SHA256);
        await fs.mkdir(resultPaths.directory, { recursive: true });
        const archiveName = "wco-result-TASK-P13-PROD-222222222222.zip";
        const archivePath = resultPaths.archivePath(archiveName);
        const archive = Buffer.from("phase13-adapter-archive");
        const archiveSha256 = crypto.createHash("sha256").update(archive).digest("hex");
        await fs.writeFile(archivePath, archive);
        const fakeReceipt = {
          run_id: RUN_ID,
          state: "READY_FOR_WEB_REVIEW",
          archive_relative_path: path.relative(options.stateDirectory, archivePath).replace(/\\/g, "/"),
          archive_sha256: archiveSha256,
        } as ResultBundleReceipt;
        await fs.writeFile(resultPaths.receiptPath, JSON.stringify(fakeReceipt));
        return fakeReceipt;
      },
    },
  );

  assert.equal(receipt.state, "READY_FOR_WEB_REVIEW");
  assert.ok(observedCompatibilityRoot.includes(".phase13-result-compat-"));
  await assert.rejects(() => fs.lstat(observedCompatibilityRoot), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const actualPaths = resultBundlePaths(root, TASK_ID, TASK_BUNDLE_SHA256);
  assert.equal(await fs.readFile(actualPaths.archivePath("wco-result-TASK-P13-PROD-222222222222.zip"), "utf8"), "phase13-adapter-archive");
  assert.equal(JSON.parse(await fs.readFile(actualPaths.receiptPath, "utf8")).run_id, RUN_ID);
});
