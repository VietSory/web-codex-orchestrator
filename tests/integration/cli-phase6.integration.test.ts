import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import http from "node:http";

import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

test("Phase 6 CLI Integration - compiled CLI loads resources and packages bundle", async (t) => {
  const rootDir = path.resolve(__dirname, "../..");
  const cliPath = path.join(rootDir, "dist", "cli", "index.js");
  try {
    await fs.access(cliPath);
  } catch {
    assert.fail("CLI not built. Run 'npm run build' before testing.");
  }

  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-cli-phase6-test-"));
  tmpDir = await fs.realpath(tmpDir);
  
  const sharedState = { headCommit: "pending" };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/repos/owner/repo/pulls/123") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        number: 123,
        html_url: "https://github.com/owner/repo/pull/123",
        state: "open",
        draft: true,
        merged: false,
        merged_at: null,
        title: "Test PR",
        head: { ref: "codex/task", sha: sharedState.headCommit }, // will be checked against expected
        base: { ref: "main" }
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const mockGithubUrl = `http://localhost:${port}`;

  try {
    const worktreePath = path.join(tmpDir, "repo");
    const stateDirectory = path.join(tmpDir, "state");
    const bundlePath = path.join(tmpDir, "bundle");
    const configPath = path.join(tmpDir, "config.json");
    
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.mkdir(bundlePath, { recursive: true });

    await fs.writeFile(configPath, JSON.stringify({
      config_version: "1.0",
      inbox: {
        poll_interval_ms: 1000,
        stable_age_ms: 1000,
        stable_observations: 1,
        maximum_candidates_per_scan: 1
      },
      repositories: {
        "repo": {
          path: worktreePath,
          remote: "origin",
          expected_remote_urls: ["https://github.com/owner/repo"],
          fetch_policy: "never"
        }
      },
      github_pull_request: {
        provider: "github.com",
        authentication: {
          mode: "https_token",
          token_environment_key: "WCO_GITHUB_TOKEN"
        }
      },
      result_bundle: {
        maximum_entries: 1000,
        maximum_entry_bytes: 1048576,
        maximum_total_uncompressed_bytes: 5242880,
        maximum_archive_bytes: 2097152
      }
    }));

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
    sharedState.headCommit = headCommit;

    // Setup fake task bundle
    const specFiles = ["manifest.json", "REQUEST.md", "PLAN.md", "RULES.md", "RESEARCH.md", "SOURCES.md", "VALIDATION.md", "acceptance.json", "test-matrix.json", "validation.json", "risk-policy.json"];
    const checksumsFiles: Record<string, string> = {};
    for (const name of specFiles) {
      const contentStr = name === "manifest.json" ? '{"version":"1.0"}' : (name.endsWith(".json") ? "{}" : name);
      await fs.writeFile(path.join(bundlePath, name), contentStr);
      checksumsFiles[name] = sha256Hex(contentStr);
    }
    await fs.writeFile(path.join(bundlePath, "checksums.json"), JSON.stringify({ algorithm: "sha256", files: checksumsFiles }));

    const runId = "TASK-1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const taskId = "TASK-1";
    const archiveSha = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const changeSetSha256 = sha256Hex("dummy-change-set");

    // Setup P4 Receipt
    const executionDir = path.join(stateDirectory, "runs", taskId, archiveSha, "execution");
    await fs.mkdir(executionDir, { recursive: true });
    await fs.writeFile(path.join(executionDir, "execution.json"), JSON.stringify({
      execution_version: "1.0",
      run_id: runId,
      state: "READY_FOR_PUBLISH",
      base_commit: baseCommit,
      branch_name: "codex/task",
      worktree_path: worktreePath,
      accepted_bundle_path: bundlePath,
      change_set_sha256: changeSetSha256,
      implementer: { model: "test", reasoning_effort: "low", thread_id: "test", iterations: 1 },
      internal_reviewer: { model: "test", reasoning_effort: "low", rounds: 1, latest_thread_id: null, verdict: "APPROVE", reviewed_change_set_sha256: changeSetSha256 },
      final_reviewer: { model: "test", reasoning_effort: "low", rounds: 0, latest_thread_id: null, verdict: "APPROVE", reviewed_change_set_sha256: changeSetSha256 },
      verification: { rounds: 1, required_commands_passed: true, verified_change_set_sha256: changeSetSha256, commands: [] },
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 },
      errors: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    }));

    // Setup P5A Receipt
    const publishDir = path.join(executionDir, "publish");
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
    await fs.mkdir(path.join(stateDirectory, "publish"), { recursive: true });
    await fs.writeFile(path.join(stateDirectory, "publish", "github-draft-pr.json"), JSON.stringify({
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

    // Mock head commit in server response
    server.on("request", (req, res) => {
      // server already closed or handled in initial handler
    });

    let stdout, stderr;
    try {
      const result = await exec("node", [
        cliPath,
        "package-result",
        "--run-id", runId,
        "--state-dir", stateDirectory,
        "--config", configPath,
        "--json"
      ], {
        env: {
          ...process.env,
          GITHUB_API_URL: mockGithubUrl,
          WCO_GITHUB_TOKEN: "fake-token"
        }
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: any) {
      console.error("CLI Execution failed!");
      console.error("Exit Code:", err.code);
      console.error("STDOUT:", err.stdout);
      console.error("STDERR:", err.stderr);
      throw err;
    }

    const out = JSON.parse(stdout);
    assert.strictEqual(out.state, "READY_FOR_WEB_REVIEW", "CLI should succeed and reach READY_FOR_WEB_REVIEW");
    
    // Explicitly check that resources were copied in the build step, and CLI ran fine
    const resourcesDir = path.join(rootDir, "dist", "result-bundle", "resources");
    const files = await fs.readdir(resourcesDir);
    assert.ok(files.includes("WEB-REVIEW-CONTRACT.md"));
    assert.ok(files.includes("web-review-policy.json"));

  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
