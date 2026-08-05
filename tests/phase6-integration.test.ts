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
  let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-phase6-test-"));
  tmpDir = await fs.realpath(tmpDir);
  
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
    await fs.writeFile(path.join(bundlePath, "manifest.json"), JSON.stringify({ version: "1.0" }));
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
    const specFiles = ["manifest.json", "REQUEST.md", "PLAN.md", "RULES.md", "RESEARCH.md", "SOURCES.md", "VALIDATION.md", "acceptance.json", "test-matrix.json", "validation.json", "risk-policy.json"];
    const checksumsFiles: Record<string, string> = {};
    for (const name of specFiles) {
      const content = await fs.readFile(path.join(bundlePath, name));
      checksumsFiles[name] = sha256Hex(content);
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
    console.log("ACTUAL ARCHIVE PATH:", receipt.archive_relative_path);
    console.log("EXPECTED PREFIX:", `handoff/runs/${taskId}/${archiveSha}`.replace(/\\/g, "/"));
    assert.ok(receipt.archive_relative_path!.startsWith(`handoff/runs/${taskId}/${archiveSha}`.replace(/\\/g, "/")));
    assert.ok(receipt.spec_set_sha256!.length === 64, "Should have spec_set_sha256");
    assert.ok(receipt.review_contract_sha256!.length === 64, "Should have review_contract_sha256");
    assert.ok(receipt.review_policy_sha256!.length === 64, "Should have review_policy_sha256");
    assert.ok(receipt.verdict_schema_sha256!.length === 64, "Should have verdict_schema_sha256");
    assert.ok(receipt.revision_request_schema_sha256!.length === 64, "Should have revision_request_schema_sha256");
    assert.ok(receipt.reviewed_entry_set_sha256!.length === 64, "Should have reviewed_entry_set_sha256");
    
    // Verify Zip manually via verifier
    const absoluteZipPath = path.join(stateDirectory, receipt.archive_relative_path!);
    const stat = await fs.stat(absoluteZipPath);
    assert.equal(stat.size, receipt.archive_size_bytes);

    // Unpack ZIP to assert on evidence contents
    const yauzl = await import("yauzl");
    const zipEntries = new Map<string, Buffer>();
    await new Promise<void>((resolve, reject) => {
      yauzl.open(absoluteZipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) return reject(err);
        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          zipfile.openReadStream(entry, (err, stream) => {
            if (err || !stream) return reject(err);
            const chunks: Buffer[] = [];
            stream.on("data", (c) => chunks.push(c));
            stream.on("end", () => {
              zipEntries.set(entry.fileName, Buffer.concat(chunks));
              zipfile.readEntry();
            });
            stream.on("error", reject);
          });
        });
        zipfile.on("end", () => resolve());
        zipfile.on("error", reject);
      });
    });

    // Check evidence contents
    const execBuf = zipEntries.get("evidence/execution.json");
    assert.ok(execBuf, "evidence/execution.json should exist in archive");
    const execJson = JSON.parse(execBuf.toString("utf8"));
    assert.equal(execJson.run_id, runId);
    assert.equal(execJson.state, "READY_FOR_PUBLISH");
    assert.equal(execJson.implementer.model, "test");

    const draftPrBuf = zipEntries.get("evidence/github-draft-pr.json");
    assert.ok(draftPrBuf, "evidence/github-draft-pr.json should exist in archive");
    const draftPrJson = JSON.parse(draftPrBuf.toString("utf8"));
    assert.equal(draftPrJson.pull_request_number, 123);
    assert.equal(draftPrJson.pull_request_url, "https://github.com/owner/repo/pull/123");
    
    // Ensure manifest is intact and recomputed reviewed_entry_set_sha256 matches receipt
    const manifestBuf = zipEntries.get("manifest.json");
    assert.ok(manifestBuf, "manifest.json should exist in archive");
    const manifestObj = JSON.parse(manifestBuf.toString("utf8"));
    assert.ok(manifestObj.reviewed_entry_set_sha256, "manifest.json should have reviewed_entry_set_sha256");
    assert.equal(manifestObj.reviewed_entry_set_sha256, receipt.reviewed_entry_set_sha256);

    const { canonicalJsonBuffer } = await import("../src/result-bundle/canonical-json.js");
    const sortedManifestEntries = [...manifestObj.entries].sort((a: any, b: any) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    const recomputedHash = sha256Hex(canonicalJsonBuffer(sortedManifestEntries));
    assert.equal(recomputedHash, receipt.reviewed_entry_set_sha256);

    // === BUILD 2 (Determinism check) ===
    const archive1Bytes = await fs.readFile(absoluteZipPath);
    await fs.rm(path.join(stateDirectory, "handoff", "runs", taskId, archiveSha, "result-bundle.json"));
    await fs.rm(absoluteZipPath);

    const receipt2 = await packageResultBundle({
      runId,
      stateDirectory,
      configPath: "dummy.json", // Not used locally
      githubClient,
      gitRunner,
      now: () => new Date("2026-02-15T08:30:00.000Z") // different time
    });

    const archive2Path = path.join(stateDirectory, receipt2.archive_relative_path!);
    const archive2Bytes = await fs.readFile(archive2Path);

    assert.strictEqual(
      archive1Bytes.byteLength,
      archive2Bytes.byteLength,
      "Archives must have the exact same size"
    );

    assert.strictEqual(
      sha256Hex(archive1Bytes),
      sha256Hex(archive2Bytes),
      "Archives must be byte-for-byte identical despite different build times"
    );

    assert.strictEqual(
      receipt.archive_sha256,
      receipt2.archive_sha256,
      "Archive SHA-256 in receipts must match"
    );

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
