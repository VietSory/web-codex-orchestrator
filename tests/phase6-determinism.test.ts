import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { packageResultBundle } from "../src/result-bundle/result-bundle-service.js";
import { resultBundlePaths } from "../src/result-bundle/result-bundle-paths.js";
import type { GitHubAttestationClient, PullRequestAttestation } from "../src/result-bundle/github-attestation.js";
import type { GitRunner } from "../src/result-bundle/git-evidence-reader.js";

function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

class FakeGitHubClient implements GitHubAttestationClient {
  async attest(owner: string, repo: string, pullNumber: number): Promise<PullRequestAttestation> {
    return {
      number: pullNumber,
      url: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
      state: "OPEN",
      draft: true,
      head_sha: "c000000000000000000000000000000000000000",
      base_ref: "main",
      title: "Test PR",
      body: "Test Body",
      attested_at: "2024-01-01T00:00:00.000Z",
    };
  }
  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<any> {
    return { 
      number: pullNumber,
      html_url: "https://github.com/fake/fake/pull/1",
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      title: "Test PR",
      head: { ref: "", sha: "c000000000000000000000000000000000000000" },
      base: { ref: "base0000000000000000000000000000000000000" }
    };
  }
}

const fakeGitRunner: GitRunner = {
  async run() { return { stdout: "" }; },
  async runBinary() { return Buffer.alloc(0); },
};

test("Phase 6 Determinism - byte-for-byte identical archives", async (t) => {
  const rootDir = process.cwd();
  const stateDir = path.join(rootDir, "tests", "fixtures", "tmp-determinism-state");
  const taskId = "task-det";
  const archiveSha = "0000000000000000000000000000000000000000000000000000000000000000";
  const runId = `${taskId}:${archiveSha}`;

  // Create fake input state
  const executionDir = path.join(stateDir, "runs", taskId, archiveSha, "execution");
  await fs.mkdir(executionDir, { recursive: true });
  await fs.mkdir(path.join(stateDir, "runs", taskId, archiveSha, "bundle"), { recursive: true });
  const publishDir = path.join(executionDir, "publish");
  await fs.mkdir(publishDir, { recursive: true });

  const executionReceipt = {
    receipt_version: "1.0",
    run_id: runId,
    state: "READY_FOR_PUBLISH",
    change_set_sha256: "change0000000000000000000000000000000000000000000000000000000000",
    base_commit: "base0000000000000000000000000000000000000",
    created_at: "2024-01-01T00:00:00.000Z",
  };
  await fs.writeFile(path.join(executionDir, "execution.json"), JSON.stringify(executionReceipt));

  const p5aReceipt = {
    receipt_version: "1.0",
    run_id: runId,
    state: "PUSHED",
    change_set_sha256: executionReceipt.change_set_sha256,
    base_commit: executionReceipt.base_commit,
    commit_sha: "c000000000000000000000000000000000000000",
    remote_branch_sha: "c000000000000000000000000000000000000000",
    allowed_remote_url: "https://github.com/test/repo",
  };
  await fs.writeFile(path.join(publishDir, "git-publish.json"), JSON.stringify(p5aReceipt));

  const p5bReceipt = {
    receipt_version: "1.0",
    run_id: runId,
    state: "OPEN",
    expected_head_sha: p5aReceipt.commit_sha,
    pull_number: 123,
    pull_url: "https://github.com/test/repo/pull/123",
  };
  const globalPublishDir = path.join(stateDir, "publish");
  await fs.mkdir(globalPublishDir, { recursive: true });
  await fs.writeFile(path.join(globalPublishDir, "github-draft-pr.json"), JSON.stringify(p5bReceipt));

  // Create fake bundle files
  const bundlePath = path.join(stateDir, "runs", taskId, archiveSha, "bundle");
  const specFiles = ["manifest.json", "REQUEST.md", "PLAN.md", "RULES.md", "RESEARCH.md", "SOURCES.md", "VALIDATION.md", "acceptance.json", "checksums.json", "test-matrix.json", "validation.json", "risk-policy.json"];
  const checksumsFiles: Record<string, string> = {};
  
  for (const name of specFiles) {
    if (name !== "checksums.json") {
      const content = Buffer.from(name);
      await fs.writeFile(path.join(bundlePath, name), content);
      checksumsFiles[name] = sha256Hex(content);
    }
  }
  const checksumsJson = { algorithm: "sha256", files: checksumsFiles };
  await fs.writeFile(path.join(bundlePath, "checksums.json"), JSON.stringify(checksumsJson));

  try {
    // Build 1
    const receipt1 = await packageResultBundle({
      runId,
      stateDirectory: stateDir,
      configPath: "",
      githubClient: new FakeGitHubClient(),
      gitRunner: fakeGitRunner,
      now: () => new Date("2024-02-01T12:00:00.000Z"), // time A
    });

    const archive1Path = path.join(stateDir, "handoff", "runs", taskId, archiveSha, path.basename(receipt1.archive_relative_path));
    const archive1Bytes = await fs.readFile(archive1Path);

    // Delete receipt so it rebuilds instead of returning existing
    await fs.rm(path.join(stateDir, "handoff", "runs", taskId, archiveSha, "result-bundle.json"));
    await fs.rm(archive1Path);

    // Build 2
    const receipt2 = await packageResultBundle({
      runId,
      stateDirectory: stateDir,
      configPath: "",
      githubClient: new FakeGitHubClient(),
      gitRunner: fakeGitRunner,
      now: () => new Date("2024-03-15T08:30:00.000Z"), // time B
    });

    const archive2Path = path.join(stateDir, "handoff", "runs", taskId, archiveSha, path.basename(receipt2.archive_relative_path));
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
      receipt1.archive_sha256,
      receipt2.archive_sha256,
      "Archive SHA-256 in receipts must match"
    );

  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
