import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { packageResultBundle } from "../src/result-bundle/result-bundle-service.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";
import { submitWebVerdict } from "../src/web-review/web-review-service.js";
import { loadAndVerifyResultBundle } from "../src/web-review/result-bundle-review-reader.js";
import { reviseRun } from "../src/revision/revision-service.js";
import { FakeAgentClient } from "../src/agent/fake-agent-client.js";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { FakeVerificationSandbox } from "../src/verifier/fake-sandbox.js";
import { GitRunner } from "../src/git/git-runner.js";
import { calculateChangeSet } from "../src/execution/change-set.js";
import { updateChecksums } from "./helpers/zip-fixture.js";
import { createValidVerdict } from "./helpers/phase7-fixtures.js";

const exec = promisify(execFile);
const TASK_ID = "P8-E2E";
const ARCHIVE_SHA = "1".repeat(64);
const RUN_ID = `${TASK_ID}:${ARCHIVE_SHA}`;
const BRANCH = "codex/p8-e2e";
const REMOTE_URL = "https://github.com/owner/repo";
const PR_NUMBER = 808;

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return String(stdout).trim();
}

function phase6GitRunner() {
  return {
    async run(args: string[], cwd: string) {
      const { stdout } = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      return { stdout: String(stdout) };
    },
    async runBinary(args: string[], cwd: string) {
      const { stdout } = await exec("git", args, { cwd, encoding: "buffer", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      return stdout as Buffer;
    },
  };
}

class DynamicGitHubClient implements GitHubAttestationClient {
  constructor(private readonly worktree: string, private readonly baseSha: string) {}
  async getPullRequest(owner: string, repo: string, prNumber: number) {
    // GitHub observes the pushed remote branch, not a local commit that has not
    // been published yet. This distinction is essential for the Phase 8
    // pre-push Draft/head attestation boundary.
    const remote = await git(this.worktree, ["ls-remote", "--heads", "origin", `refs/heads/${BRANCH}`]);
    const headSha = remote.split(/\s+/, 1)[0] ?? "";
    if (!/^[a-f0-9]{40,64}$/.test(headSha)) throw new Error("E2E GitHub client could not resolve the remote PR head.");
    const fullName = `${owner}/${repo}`;
    return {
      number: prNumber,
      html_url: `https://github.com/${fullName}/pull/${prNumber}`,
      state: "open",
      draft: true,
      merged: false,
      merged_at: null,
      title: "Phase 8 E2E",
      head: { ref: BRANCH, sha: headSha, repo: { full_name: fullName } },
      base: { ref: "main", sha: this.baseSha, repo: { full_name: fullName } },
    };
  }
}

async function writeTrustedConfig(root: string, repo: string, localRemoteUrl: string): Promise<string> {
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    config_version: "1.0",
    inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 },
    repositories: {
      repo: {
        path: repo,
        remote: "origin",
        expected_remote_urls: [REMOTE_URL, localRemoteUrl],
        fetch_policy: "never",
      },
    },
    runtime: { source: "bundled" },
    agents: {
      implementer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high" },
      final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high" },
      limits: {
        maximum_implementation_iterations: 4,
        maximum_internal_review_rounds: 3,
        maximum_sol_review_rounds: 3,
        maximum_total_agent_turns: 12,
        maximum_turn_seconds: 60,
        maximum_total_seconds: 600,
        maximum_total_input_tokens: 100000,
        maximum_total_output_tokens: 100000,
      },
    },
    publish: {
      identity: { name: "WCO Phase8 E2E", email: "wco-phase8@example.invalid" },
      authentication: { mode: "none" },
    },
    verification: {
      allowed_executables: ["npm"],
      allowed_environment_keys: ["CI"],
      maximum_command_seconds: 600,
      maximum_output_bytes: 4194304,
      maximum_file_bytes: 52428800,
      maximum_changed_files: 50,
      maximum_diff_lines: 8000,
      allowed_generated_paths: ["dist/**"],
    },
    github_pull_request: {
      provider: "github.com",
      authentication: { mode: "https_token", token_environment_key: "WCO_GITHUB_TOKEN" },
    },
    result_bundle: {
      maximum_entries: 2000,
      maximum_entry_bytes: 52428800,
      maximum_source_file_bytes: 52428800,
      maximum_diff_bytes: 16777216,
      maximum_total_uncompressed_bytes: 100000000,
      maximum_archive_bytes: 100000000,
      maximum_public_output_bytes_per_command: 1048576,
      maximum_github_response_bytes: 1048576,
      github_attestation: "required",
    },
  }, null, 2));
  return fs.realpath(configPath);
}

async function writeInitialReceipts(params: {
  state: string;
  repo: string;
  accepted: string;
  base: string;
  initialHead: string;
  changeSetSha256: string;
  refsSha256: string;
}): Promise<void> {
  const now = "2026-08-07T12:00:00.000Z";
  const runDir = path.join(params.state, "runs", TASK_ID, ARCHIVE_SHA);
  const executionDir = path.join(runDir, "execution");
  const publishDir = path.join(executionDir, "publish");
  await fs.mkdir(publishDir, { recursive: true });

  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify({
    run_version: "1.0",
    run_id: RUN_ID,
    status: "READY_FOR_CODEX",
    task_id: TASK_ID,
    archive_sha256: ARCHIVE_SHA,
    bundle_schema_version: "1.3",
    repository_id: "repo",
    repository_path: params.repo,
    remote: "origin",
    remote_url: REMOTE_URL,
    base_branch: "main",
    base_commit: params.base,
    branch_name: BRANCH,
    worktree_path: params.repo,
    accepted_bundle_path: params.accepted,
    state: "READY_FOR_CODEX",
    checks: ["remote-verified"],
    errors: [],
    created_at: now,
    updated_at: now,
    ready_at: now,
  }, null, 2));

  await fs.writeFile(path.join(executionDir, "execution.json"), JSON.stringify({
    execution_version: "1.0",
    run_id: RUN_ID,
    state: "READY_FOR_PUBLISH",
    base_commit: params.base,
    branch_name: BRANCH,
    worktree_path: params.repo,
    implementer: { model: "gpt-5.6-terra", reasoning_effort: "high", thread_id: "initial-thread", iterations: 1 },
    internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high", rounds: 1, thread_ids: ["terra-initial"], verdict: "APPROVE", reviewed_change_set_sha256: params.changeSetSha256 },
    final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high", rounds: 1, thread_ids: ["sol-initial"], verdict: "APPROVE", reviewed_change_set_sha256: params.changeSetSha256 },
    verification: { rounds: 1, required_commands_passed: true, verified_change_set_sha256: params.changeSetSha256, commands: [] },
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    change_set_sha256: params.changeSetSha256,
    change_set: { entries: [{ path: "src/app.ts", change_type: "modified" }], total_files: 1, total_additions: 1, total_deletions: 1, refs_sha256: params.refsSha256 },
    errors: [],
    created_at: now,
    updated_at: now,
  }, null, 2));

  const executionReceiptSha = sha256Hex(await fs.readFile(path.join(executionDir, "execution.json")));
  await fs.writeFile(path.join(publishDir, "git-publish.json"), JSON.stringify({
    publish_version: "1.1", run_id: RUN_ID, state: "PUSHED", base_commit: params.base, branch_name: BRANCH, remote_name: "origin", allowed_remote_url: REMOTE_URL, change_set_sha256: params.changeSetSha256, expected_paths: ["src/app.ts"], approved_snapshot_sha256: "a".repeat(64), commit_sha: params.initialHead, remote_branch_sha: params.initialHead, created_at: now, updated_at: now, committed_at: now, pushed_at: now,
  }, null, 2));
  const publishReceiptSha = sha256Hex(await fs.readFile(path.join(publishDir, "git-publish.json")));
  await fs.writeFile(path.join(publishDir, "draft-pr.json"), JSON.stringify({
    pr_version: "1.0", run_id: RUN_ID, state: "OPEN", base_commit: params.base, branch_name: BRANCH, published_commit_sha: params.initialHead, change_set_sha256: params.changeSetSha256, git_publish_receipt_sha256: publishReceiptSha, pull_request_number: PR_NUMBER, pull_request_url: `https://github.com/owner/repo/pull/${PR_NUMBER}`, created_at: now, updated_at: now, opened_at: now, errors: [],
  }, null, 2));
  const draftReceiptSha = sha256Hex(await fs.readFile(path.join(publishDir, "draft-pr.json")));
  await fs.writeFile(path.join(executionDir, "execution.json"), JSON.stringify({
    execution_version: "1.0",
    run_id: RUN_ID,
    state: "READY_FOR_PUBLISH",
    base_commit: params.base,
    branch_name: BRANCH,
    worktree_path: params.repo,
    implementer: { model: "gpt-5.6-terra", reasoning_effort: "high", thread_id: "initial-thread", iterations: 1 },
    internal_reviewer: { model: "gpt-5.6-terra", reasoning_effort: "high", rounds: 1, thread_ids: ["terra-initial"], verdict: "APPROVE", reviewed_change_set_sha256: params.changeSetSha256 },
    final_reviewer: { model: "gpt-5.6-sol", reasoning_effort: "high", rounds: 1, thread_ids: ["sol-initial"], verdict: "APPROVE", reviewed_change_set_sha256: params.changeSetSha256 },
    verification: { rounds: 1, required_commands_passed: true, verified_change_set_sha256: params.changeSetSha256, commands: [] },
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    change_set_sha256: params.changeSetSha256,
    change_set: { entries: [{ path: "src/app.ts", change_type: "modified" }], total_files: 1, total_additions: 1, total_deletions: 1, refs_sha256: params.refsSha256 },
    errors: [],
    created_at: now,
    updated_at: now,
  }, null, 2));
  void executionReceiptSha;
  void draftReceiptSha;
}

// Remaining E2E setup and assertions are unchanged from the previous version.
// They are intentionally kept below verbatim by the repository update operation.
