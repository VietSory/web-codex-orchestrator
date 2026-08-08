import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { acquireExecutionLock } from "../src/execution/execution-lock.js";
import { ExecutionError } from "../src/execution/errors.js";
import {
  createDraftPullRequestForRun,
  createPreparedDraftPullRequest,
} from "../src/pull-request/phase5b-service.js";
import { DraftPullRequestError } from "../src/pull-request/contracts.js";
import { GitHubRestPullRequestClient } from "../src/pull-request/github-rest-client.js";

async function createTestEnv() {
  const tmpBase = await fs.promises.realpath(os.tmpdir());
  const stateDirectory = await fs.promises.realpath(fs.mkdtempSync(path.join(tmpBase, "wco-p5b-")));
  const rootPublishDir = path.join(stateDirectory, "publish");
  fs.mkdirSync(rootPublishDir, { recursive: true });
  fs.mkdirSync(path.join(stateDirectory, "intake"), { recursive: true });

  const runId = `testtask1:${"a".repeat(64)}`;
  const taskId = "testtask1";
  const archiveSha256 = "a".repeat(64);
  const changeSetSha256 = "b".repeat(64);
  const runsDir = path.join(stateDirectory, "runs", taskId, archiveSha256);
  fs.mkdirSync(runsDir, { recursive: true });
  const executionDir = path.join(runsDir, "execution");
  const phase5aPublishDir = path.join(executionDir, "publish");
  fs.mkdirSync(phase5aPublishDir, { recursive: true });

  const bundleDir = path.join(stateDirectory, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });

  const filesToMock = {
    "manifest.json": JSON.stringify({
      schema_version: "1.3",
      task_id: taskId,
      title: "Test Task",
      repository: { id: "testrepo", base_branch: "main", base_commit: "0".repeat(40) },
      delivery: { mode: "github_pull_request", remote: "origin", branch_name: "codex/feature", base_branch: "main", draft: true, auto_merge: false, push_after: ["VERIFIER_PASS", "SOL_APPROVE"] },
      git_policy: { allowed_remote: "origin", allow_force_push: false, allow_remote_branch_delete: false, allow_merge: false, allowed_branch_prefix: "codex/", deny_direct_push_branches: ["main", "master"] },
    }),
    "validation.json": "{}",
    "acceptance.json": "{}",
    "test-matrix.json": "{}",
    "risk-policy.json": "{}",
  };

  const filesMap: Record<string, string> = {};
  for (const [filename, content] of Object.entries(filesToMock)) {
    fs.writeFileSync(path.join(bundleDir, filename), content);
    filesMap[filename] = crypto.createHash("sha256").update(content).digest("hex");
  }
  fs.writeFileSync(path.join(bundleDir, "checksums.json"), JSON.stringify({ algorithm: "sha256", files: filesMap }));

  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(runsDir, "run.json"), JSON.stringify({
    run_version: "1.0",
    run_id: runId,
    task_id: taskId,
    archive_sha256: archiveSha256,
    bundle_schema_version: "1.3",
    state: "READY_FOR_CODEX",
    status: "READY_FOR_CODEX",
    repository_id: "testrepo",
    repository_path: "/tmp/repo",
    remote: "origin",
    remote_url: "https://github.com/foo/bar",
    base_branch: "main",
    base_commit: "0".repeat(40),
    branch_name: "codex/feature",
    worktree_path: "/tmp/fake-worktree",
    accepted_bundle_path: bundleDir,
    checks: [],
    errors: [],
    created_at: timestamp,
    updated_at: timestamp,
  }));

  fs.writeFileSync(path.join(executionDir, "execution.json"), JSON.stringify({
    execution_version: "1.0",
    run_id: runId,
    state: "READY_FOR_PUBLISH",
    base_commit: "0".repeat(40),
    branch_name: "codex/feature",
    worktree_path: "/tmp/fake-worktree",
    accepted_bundle_path: bundleDir,
    implementer: { model: "test", reasoning_effort: "test", iterations: 1, thread_id: "" },
    internal_reviewer: { model: "test", reasoning_effort: "test", rounds: 1, latest_thread_id: null, verdict: "APPROVE", reviewed_change_set_sha256: changeSetSha256 },
    final_reviewer: { model: "test", reasoning_effort: "test", rounds: 1, latest_thread_id: null, verdict: "APPROVE", reviewed_change_set_sha256: changeSetSha256 },
    verification: { commands: [], rounds: 1, required_commands_passed: true, verified_change_set_sha256: changeSetSha256 },
    errors: [],
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    change_set_sha256: changeSetSha256,
    created_at: timestamp,
    updated_at: timestamp,
  }));

  const phase5aReceipt = {
    publish_version: "1.1",
    run_id: runId,
    state: "PUSHED",
    base_commit: "0".repeat(40),
    branch_name: "codex/feature",
    remote_name: "origin",
    allowed_remote_url: "https://github.com/foo/bar",
    change_set_sha256: changeSetSha256,
    expected_paths: ["foo.txt"],
    approved_snapshot_sha256: changeSetSha256,
    commit_sha: "1".repeat(40),
    remote_branch_sha: "1".repeat(40),
    created_at: timestamp,
    updated_at: timestamp,
    committed_at: timestamp,
    pushed_at: timestamp,
  };
  const p5aPath = path.join(phase5aPublishDir, "git-publish.json");
  fs.writeFileSync(p5aPath, JSON.stringify(phase5aReceipt));

  const configPath = path.join(stateDirectory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 },
    repositories: {
      testrepo: {
        path: "/tmp/repo",
        remote: "origin",
        expected_remote_urls: ["https://github.com/foo/bar"],
        fetch_policy: "always",
      },
    },
    runtime: { source: "bundled", codex_home: "/tmp" },
    agents: {
      implementer: { model: "test", reasoning_effort: "low" },
      internal_reviewer: { model: "test", reasoning_effort: "low" },
      final_reviewer: { model: "test", reasoning_effort: "low" },
      limits: {
        maximum_implementation_iterations: 1,
        maximum_internal_review_rounds: 1,
        maximum_sol_review_rounds: 1,
        maximum_total_agent_turns: 1,
        maximum_turn_seconds: 1,
        maximum_total_seconds: 1,
        maximum_total_input_tokens: 1,
        maximum_total_output_tokens: 1,
      },
    },
    verification: {
      allowed_executables: ["npm"],
      allowed_environment_keys: ["NODE_ENV"],
      maximum_command_seconds: 10,
      maximum_output_bytes: 10,
      maximum_file_bytes: 10,
      maximum_changed_files: 10,
      maximum_diff_lines: 10,
      allowed_generated_paths: [],
    },
    github_pull_request: {
      provider: "github.com",
      authentication: { mode: "https_token", token_environment_key: "WCO_GITHUB_TOKEN" },
    },
    publish: {
      identity: { name: "Test", email: "test@example.com" },
      authentication: { mode: "https_token", token_environment_key: "WCO_GIT_TEST_TOKEN" },
    },
  }));

  return { stateDirectory, configPath, runId, taskId, archiveSha256, p5aPath, phase5aReceipt, rootPublishDir };
}

function preparedContext(root: string, gitRunner: { run(args: string[], cwd: string): Promise<{ stdout: string }> }) {
  const client = {
    async listByHead() { return []; },
    async get() { throw new Error("unexpected get"); },
    async createDraft() { throw new Error("unexpected create"); },
  };
  return {
    runId: `task:${"a".repeat(64)}`,
    taskId: "task",
    owner: "foo",
    repository: "bar",
    baseBranch: "main",
    headBranch: "codex/feature",
    expectedHeadSha: "1".repeat(40),
    changeSetSha256: "b".repeat(64),
    gitPublishReceiptSha256: "c".repeat(64),
    client: client as never,
    existingReceipt: null,
    stateDirectory: root,
    gitRunner,
    worktreePath: root,
    remoteName: "origin",
  };
}

test("P5B-001: phase-boundary rejects a mismatched canonical Phase 5A receipt", async (t) => {
  const env = await createTestEnv();
  t.after(async () => fs.promises.rm(env.stateDirectory, { recursive: true, force: true }));
  const p5a = JSON.parse(fs.readFileSync(env.p5aPath, "utf8"));
  p5a.run_id = `wrong-run-id:${"f".repeat(64)}`;
  fs.writeFileSync(env.p5aPath, JSON.stringify(p5a));
  await assert.rejects(
    createDraftPullRequestForRun({ runId: env.runId, stateDirectory: env.stateDirectory, configPath: env.configPath }),
    (err: unknown) => err instanceof DraftPullRequestError && err.code === "PR_PHASE5A_NOT_PUSHED",
  );
});

test("P5B-002: remote-attestation rejects a mismatched remote head", async (t) => {
  const root = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "wco-p5b-head-")));
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));
  const context = preparedContext(root, {
    async run(args) {
      if (args.at(-1) === "refs/heads/codex/feature") return { stdout: `${"2".repeat(40)}\trefs/heads/codex/feature\n` };
      return { stdout: `${"3".repeat(40)}\trefs/heads/main\n` };
    },
  });
  await assert.rejects(createPreparedDraftPullRequest(context), (err: unknown) => err instanceof DraftPullRequestError && err.code === "PR_REMOTE_BRANCH_MISMATCH");
});

test("P5B-003: base-attestation rejects a missing remote base branch", async (t) => {
  const root = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "wco-p5b-base-")));
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));
  const context = preparedContext(root, {
    async run(args) {
      if (args.at(-1) === "refs/heads/codex/feature") return { stdout: `${"1".repeat(40)}\trefs/heads/codex/feature\n` };
      return { stdout: "" };
    },
  });
  await assert.rejects(createPreparedDraftPullRequest(context), (err: unknown) => err instanceof DraftPullRequestError && err.code === "PR_BASE_BRANCH_MISSING");
});

test("P5B-005: authentication missing token throws and cleans temporary Git auth", async (t) => {
  const env = await createTestEnv();
  t.after(async () => fs.promises.rm(env.stateDirectory, { recursive: true, force: true }));
  const origGithub = process.env.WCO_GITHUB_TOKEN;
  const origGit = process.env.WCO_GIT_TEST_TOKEN;
  delete process.env.WCO_GITHUB_TOKEN;
  process.env.WCO_GIT_TEST_TOKEN = "fake-git-token";
  try {
    await assert.rejects(
      createDraftPullRequestForRun({ runId: env.runId, stateDirectory: env.stateDirectory, configPath: env.configPath }),
      (err: unknown) => err instanceof DraftPullRequestError && err.code === "PR_AUTH_UNAVAILABLE",
    );
    const runtimeEntries = await fs.promises.readdir(path.join(env.stateDirectory, "git-runtime"));
    assert.equal(runtimeEntries.some((entry) => entry.includes("askpass")), false);
  } finally {
    if (origGithub !== undefined) process.env.WCO_GITHUB_TOKEN = origGithub;
    else delete process.env.WCO_GITHUB_TOKEN;
    if (origGit !== undefined) process.env.WCO_GIT_TEST_TOKEN = origGit;
    else delete process.env.WCO_GIT_TEST_TOKEN;
  }
});

test("P5B-034: malformed persisted Draft PR receipt fails before network mutation", async (t) => {
  const env = await createTestEnv();
  t.after(async () => fs.promises.rm(env.stateDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(env.rootPublishDir, "github-draft-pr.json"), "malformed-json");
  const origGithub = process.env.WCO_GITHUB_TOKEN;
  const origGit = process.env.WCO_GIT_TEST_TOKEN;
  process.env.WCO_GITHUB_TOKEN = "fake-github-token";
  process.env.WCO_GIT_TEST_TOKEN = "fake-git-token";
  try {
    await assert.rejects(
      createDraftPullRequestForRun({ runId: env.runId, stateDirectory: env.stateDirectory, configPath: env.configPath }),
      (err: unknown) => err instanceof DraftPullRequestError && err.code === "PR_RECEIPT_INVALID",
    );
  } finally {
    if (origGithub !== undefined) process.env.WCO_GITHUB_TOKEN = origGithub;
    else delete process.env.WCO_GITHUB_TOKEN;
    if (origGit !== undefined) process.env.WCO_GIT_TEST_TOKEN = origGit;
    else delete process.env.WCO_GIT_TEST_TOKEN;
  }
});

test("P5B-036: execution lock rejects concurrent mutation ownership", async (t) => {
  const root = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "wco-p5b-lock-")));
  t.after(async () => fs.promises.rm(root, { recursive: true, force: true }));
  const first = await acquireExecutionLock(root, "a".repeat(64));
  t.after(async () => first.release().catch(() => undefined));
  await assert.rejects(acquireExecutionLock(root, "a".repeat(64)), (err: unknown) => err instanceof ExecutionError && err.code === "EXECUTION_LOCKED");
});

test("P5B-039: GitHub diagnostics redact configured bearer token", async () => {
  const token = "super-secret-p5b-token";
  const client = new GitHubRestPullRequestClient(token, async () => new Response(
    JSON.stringify({ message: `denied ${token}` }),
    { status: 403, headers: { "content-type": "application/json" } },
  ));
  await assert.rejects(
    client.listByHead({ owner: "foo", repository: "bar", headOwner: "foo", headBranch: "codex/feature" }),
    (err: unknown) => err instanceof DraftPullRequestError && err.code === "PR_API_FORBIDDEN" && !err.message.includes(token) && err.message.includes("[REDACTED]"),
  );
});

test("P5B-040: standalone service ignores a root-level spoof and requires the exact Phase 5A producer path", async (t) => {
  const env = await createTestEnv();
  t.after(async () => fs.promises.rm(env.stateDirectory, { recursive: true, force: true }));
  await fs.promises.unlink(env.p5aPath);
  fs.writeFileSync(path.join(env.rootPublishDir, "git-publish.json"), JSON.stringify(env.phase5aReceipt));
  await assert.rejects(
    createDraftPullRequestForRun({ runId: env.runId, stateDirectory: env.stateDirectory, configPath: env.configPath }),
    (err: unknown) => err instanceof DraftPullRequestError && err.code === "PR_PHASE5A_NOT_PUSHED",
  );
});
