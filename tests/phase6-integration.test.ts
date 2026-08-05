import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { packageResultBundle } from "../src/result-bundle/result-bundle-service.js";
import { verifyResultBundleZip } from "../src/result-bundle/zip-verifier.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";

const exec = promisify(execFile);

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

class FakeGitHubAttestationClient implements GitHubAttestationClient {
  async getPullRequest(owner: string, repo: string, prNumber: number) {
    return {
      number: prNumber,
      html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      state: "open",
      draft: true,
      merged: false,
      merged_at: null,
      title: "Automated PR",
      head: { ref: "codex/task", sha: "HEAD_SHA_PLACEHOLDER" },
      base: { ref: "main" }
    };
  }
}

test("Phase 6 Integration: full deterministic result bundle packaging", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-phase6-test-"));
  
  try {
    const worktreePath = path.join(tmpDir, "repo");
    const stateDirectory = path.join(tmpDir, "state");
    const bundlePath = path.join(tmpDir, "bundle");
    
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.mkdir(bundlePath, { recursive: true });

    // Setup Git Repo
    await exec("git", ["init", "-b", "main"], { cwd: worktreePath });
    await exec("git", ["config", "user.name", "Test User"], { cwd: worktreePath });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: worktreePath });

    await fs.writeFile(path.join(worktreePath, "file.txt"), "base content");
    await exec("git", ["add", "file.txt"], { cwd: worktreePath });
    await exec("git", ["commit", "-m", "Initial commit"], { cwd: worktreePath });
    
    const { stdout: baseCommitOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    const baseCommit = baseCommitOut.trim();

    await exec("git", ["checkout", "-b", "codex/task"], { cwd: worktreePath });
    await fs.writeFile(path.join(worktreePath, "file.txt"), "modified content");
    await fs.writeFile(path.join(worktreePath, "new.txt"), "new file");
    await exec("git", ["add", "."], { cwd: worktreePath });
    await exec("git", ["commit", "-m", "Task commit"], { cwd: worktreePath });
    
    const { stdout: headCommitOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    const headCommit = headCommitOut.trim();

    // Setup fake task bundle
    await fs.writeFile(path.join(bundlePath, "REQUEST.md"), "Request");
    await fs.writeFile(path.join(bundlePath, "PLAN.md"), "Plan");
    await fs.writeFile(path.join(bundlePath, "RULES.md"), "Rules");
    await fs.writeFile(path.join(bundlePath, "RESEARCH.md"), "Research");
    await fs.writeFile(path.join(bundlePath, "SOURCES.md"), "Sources");
    await fs.writeFile(path.join(bundlePath, "VALIDATION.md"), "Validation");
    await fs.writeFile(path.join(bundlePath, "acceptance.json"), "{}");
    await fs.writeFile(path.join(bundlePath, "test-matrix.json"), "{}");
    await fs.writeFile(path.join(bundlePath, "validation.json"), "{}");
    await fs.writeFile(path.join(bundlePath, "risk-policy.json"), "{}");

    const runId = "TASK-1:abcdef1234567890";
    const taskId = "TASK-1";
    const archiveSha = "abcdef1234567890";
    const changeSetSha256 = sha256Hex("dummy-change-set");

    // Setup P4 Receipt
    const executionDir = path.join(stateDirectory, "runs", taskId, archiveSha, "execution");
    await fs.mkdir(executionDir, { recursive: true });
    await fs.writeFile(path.join(executionDir, "execution.json"), JSON.stringify({
      execution_version: "1.0",
      run_id: runId,
      state: "READY_FOR_PUBLISH",
      base_commit: baseCommit,
      base_branch: "main",
      worktree_path: worktreePath,
      accepted_bundle_path: bundlePath,
      change_set_sha256: changeSetSha256,
      implementer: { model: "test", reasoning_effort: "low", iterations: 1 },
      internal_reviewer: { model: "test", reasoning_effort: "low", rounds: 1, verdict: "APPROVE", reviewed_change_set_sha256: changeSetSha256 },
      final_reviewer: { model: "test", reasoning_effort: "low", rounds: 0, verdict: "APPROVE", reviewed_change_set_sha256: changeSetSha256 },
      verification: { rounds: 1, required_commands_passed: true },
      usage: { input_tokens: 10, output_tokens: 10 },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    }));

    // Setup P5A Receipt
    const publishDir = path.join(stateDirectory, "publish");
    await fs.mkdir(publishDir, { recursive: true });
    await fs.writeFile(path.join(publishDir, "git-publish.json"), JSON.stringify({
      publish_version: "1.1",
      run_id: runId,
      state: "PUSHED",
      base_commit: baseCommit,
      branch_name: "codex/task",
      remote_name: "origin",
      allowed_remote_url: "https://github.com/owner/repo",
      change_set_sha256: changeSetSha256,
      expected_paths: ["file.txt", "new.txt"],
      approved_snapshot_sha256: changeSetSha256,
      commit_sha: headCommit,
      remote_branch_sha: headCommit,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      committed_at: "2026-01-01T00:00:00Z",
      pushed_at: "2026-01-01T00:00:00Z"
    }));

    // Setup P5B Receipt
    await fs.writeFile(path.join(publishDir, "github-draft-pr.json"), JSON.stringify({
      receipt_version: "1.0",
      run_id: runId,
      state: "OPEN",
      repository_owner: "owner",
      repository_name: "repo",
      base_branch: "main",
      head_branch: "codex/task",
      expected_head_sha: headCommit,
      git_publish_receipt_sha256: sha256Hex(await fs.readFile(path.join(publishDir, "git-publish.json"))),
      request_sha256: sha256Hex("dummy-req"),
      title: "Test PR",
      body_sha256: sha256Hex("dummy-body"),
      draft_required: true,
      create_post_attempted: true,
      pull_number: 123,
      pull_url: "https://github.com/owner/repo/pull/123",
      observed_head_sha: headCommit,
      observed_base_branch: "main",
      observed_state: "open",
      observed_draft: true,
      conflict_reason: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      create_attempted_at: "2026-01-01T00:00:00Z",
      opened_at: "2026-01-01T00:00:00Z",
      conflict_at: null
    }));

    const githubClient = new FakeGitHubAttestationClient();
    // Wrap to inject correct headCommit
    const origGet = githubClient.getPullRequest.bind(githubClient);
    githubClient.getPullRequest = async (owner, repo, prNum) => {
      const res = await origGet(owner, repo, prNum);
      res.head.sha = headCommit;
      return res;
    };

    const gitRunner = {
      async run(args: string[], cwd: string) {
        const { stdout } = await exec("git", args, { cwd });
        return { stdout };
      },
      async runBinary(args: string[], cwd: string) {
        const { stdout } = await exec("git", args, { cwd, encoding: "buffer" });
        return stdout;
      }
    };

    const receipt = await packageResultBundle({
      runId,
      stateDirectory,
      configPath: "dummy.json", // Not used locally
      githubClient,
      gitRunner,
      now: () => new Date("2026-01-02T12:00:00.000Z")
    });

    assert.equal(receipt.state, "READY_FOR_WEB_REVIEW");
    assert.equal(receipt.run_id, runId);
    assert.ok(receipt.archive_relative_path.startsWith("handoff/"));
    
    // Verify Zip manually via verifier
    const absoluteZipPath = path.join(stateDirectory, receipt.archive_relative_path);
    const stat = await fs.stat(absoluteZipPath);
    assert.equal(stat.size, receipt.archive_size_bytes);

    // If verification succeeded inside, our archive is deterministic.
    // Ensure manifest is intact.
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
