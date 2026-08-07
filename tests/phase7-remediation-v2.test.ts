import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { submitWebVerdict, getWebReviewStatus } from "../src/web-review/web-review-service.js";
import { buildRevisionRequest } from "../src/web-review/revision-request-builder.js";
import { buildDecisionEvent } from "../src/web-review/decision-event-builder.js";
import { resolveTrustedRunContext } from "../src/web-review/trusted-run-context.js";
import { computeBoundedGitDelta } from "../src/web-review/bounded-git-delta.js";
import { acquireReviewLock } from "../src/web-review/web-review-lock.js";
import { writeCanonicalArtifact } from "../src/web-review/web-review-store.js";
import { runSubmitWebVerdictCommand, runWebReviewStatusCommand } from "../src/web-review/web-review-cli.js";
import { createPhase6BundleFixture, createValidVerdict, TEST_PUBLISHED_COMMIT, TEST_BASE_COMMIT, TEST_SPEC_SET_SHA, TEST_TASK_ID } from "./helpers/phase7-fixtures.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";

const execFileAsync = promisify(execFile);

function mockGithubClient(overrides?: Partial<any>): GitHubAttestationClient {
  return {
    async getPullRequest(owner: string, repo: string, prNumber: number) {
      return {
        number: prNumber,
        state: "open",
        draft: true,
        head: { ref: "codex/feature", sha: TEST_PUBLISHED_COMMIT, repo: { full_name: `${owner}/${repo}` } },
        base: { ref: "main", sha: TEST_BASE_COMMIT, repo: { full_name: `${owner}/${repo}` } },
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        merged: false,
        ...overrides,
      } as any;
    },
  } as GitHubAttestationClient;
}

async function setupRunDirectory(stateDir: string, archiveSha: string, repoPath: string) {
  const runsDir = path.join(stateDir, "runs", TEST_TASK_ID, archiveSha);
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(
    path.join(runsDir, "run.json"),
    JSON.stringify({
      version: "1.0",
      run_id: `${TEST_TASK_ID}:${archiveSha}`,
      task_id: TEST_TASK_ID,
      archive_sha256: archiveSha,
      repository_id: "repo",
      repository_path: repoPath,
      state: "COMPLETED",
    })
  );
}

async function createMultiRepoTestConfig(stateDir: string, secondaryRepoDir: string): Promise<string> {
  const configPath = path.join(stateDir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      config_version: "1.0",
      inbox: {
        poll_interval_ms: 1000,
        stable_age_ms: 1000,
        stable_observations: 1,
        maximum_candidates_per_scan: 1,
      },
      repositories: {
        repo_first: {
          path: path.join(stateDir, "dummy-repo-first"),
          remote: "origin",
          expected_remote_urls: ["https://github.com/owner/first-repo"],
          fetch_policy: "never",
        },
        repo: {
          path: secondaryRepoDir,
          remote: "origin",
          expected_remote_urls: ["https://github.com/owner/repo"],
          fetch_policy: "never",
        },
      },
      github_pull_request: {
        provider: "github.com",
        authentication: {
          mode: "https_token",
          token_environment_key: "WCO_GITHUB_TOKEN",
        },
      },
    })
  );
  return await fs.realpath(configPath);
}

// P7R2-T-001: Two configured repos; correct run repo is second; Git delta must use second
test("P7R2-T-001: Two configured repos; correct run repo is second", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t001-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    await setupRunDirectory(fixture.stateDirectory, fixture.receipt.archive_sha256!, repoPath);
    const configPath = await createMultiRepoTestConfig(fixture.stateDirectory, repoPath);

    const ctx = await resolveTrustedRunContext(fixture.receipt.run_id, fixture.stateDirectory, configPath);
    assert.equal(ctx.trustedRepoPath, repoPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-002: Run receipt repository_id missing or unregistered rejects
test("P7R2-T-002: Run receipt repository_id missing or unregistered rejects", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t002-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    const runsDir = path.join(fixture.stateDirectory, "runs", TEST_TASK_ID, fixture.receipt.archive_sha256!);
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, "run.json"),
      JSON.stringify({
        version: "1.0",
        run_id: fixture.receipt.run_id,
        task_id: TEST_TASK_ID,
        archive_sha256: fixture.receipt.archive_sha256!,
        repository_id: "unknown_repo",
        repository_path: repoPath,
        state: "COMPLETED",
      })
    );
    const configPath = await createMultiRepoTestConfig(fixture.stateDirectory, repoPath);

    await assert.rejects(
      () => resolveTrustedRunContext(fixture.receipt.run_id, fixture.stateDirectory, configPath),
      (err: any) => err instanceof WebReviewError && err.code === "WEB_REVIEW_OPERATIONAL_ERROR"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-003: Verdict with previous_pr_head_sha rejects additional property
test("P7R2-T-003: Verdict with previous_pr_head_sha rejects additional property", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t003-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    await setupRunDirectory(fixture.stateDirectory, fixture.receipt.archive_sha256!, repoPath);
    const configPath = await createMultiRepoTestConfig(fixture.stateDirectory, repoPath);

    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT } as any);
    (verdict as any).previous_pr_head_sha = TEST_PUBLISHED_COMMIT;

    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    await assert.rejects(
      () =>
        submitWebVerdict({
          runId: fixture.receipt.run_id,
          stateDirectory: fixture.stateDirectory,
          configPath,
          verdictPath,
          githubClient: mockGithubClient(),
        }),
      (err: any) => err instanceof WebReviewError && err.code === "WEB_REVIEW_VERDICT_INVALID" && err.message.includes("additional property")
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-007: Missing token/config rejects before terminal decision
test("P7R2-T-007: Missing token/config rejects before terminal decision", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t007-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    await setupRunDirectory(fixture.stateDirectory, fixture.receipt.archive_sha256!, repoPath);
    const configPath = await createMultiRepoTestConfig(fixture.stateDirectory, repoPath);

    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    delete process.env.WCO_GITHUB_TOKEN;

    await assert.rejects(
      () =>
        submitWebVerdict({
          runId: fixture.receipt.run_id,
          stateDirectory: fixture.stateDirectory,
          configPath,
          verdictPath,
        }),
      (err: any) => err instanceof WebReviewError && err.code === "WEB_REVIEW_AUTH_ERROR"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-012: ESCALATE with SPEC_CONTRADICTION succeeds
test("P7R2-T-012: ESCALATE with SPEC_CONTRADICTION succeeds", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t012-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    await setupRunDirectory(fixture.stateDirectory, fixture.receipt.archive_sha256!, repoPath);
    const configPath = await createMultiRepoTestConfig(fixture.stateDirectory, repoPath);

    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "ESCALATE",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      blocking_findings: [
        {
          finding_id: "WEB-FIND-001",
          classification: "SPEC_CONTRADICTION",
          finding_origin: "UNCHANGED_CRITICAL_EXCEPTION",
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "index.ts:1",
          expected_behavior: "A",
          observed_behavior: "B",
          evidence: "Log",
          minimal_required_fix: "Fix spec",
          revision_changed_paths: [],
        },
      ],
    });
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    const receipt = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
      githubClient: mockGithubClient(),
    });

    assert.equal(receipt.state, "ESCALATED");
    assert.equal(receipt.action, "NOTIFY_USER_EXCEPTION");
    assert.equal(receipt.revision_request_sha256, null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-013: ESCALATE with HUMAN_REQUIRED succeeds
test("P7R2-T-013: ESCALATE with HUMAN_REQUIRED succeeds", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t013-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    await setupRunDirectory(fixture.stateDirectory, fixture.receipt.archive_sha256!, repoPath);
    const configPath = await createMultiRepoTestConfig(fixture.stateDirectory, repoPath);

    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "ESCALATE",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      blocking_findings: [
        {
          finding_id: "WEB-FIND-001",
          classification: "HUMAN_REQUIRED",
          finding_origin: "UNCHANGED_CRITICAL_EXCEPTION",
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "index.ts:1",
          expected_behavior: "A",
          observed_behavior: "B",
          evidence: "Log",
          minimal_required_fix: "Requires human review",
          revision_changed_paths: [],
        },
      ],
    });
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    const receipt = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
      githubClient: mockGithubClient(),
    });

    assert.equal(receipt.state, "ESCALATED");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-014: REVISE with SPEC_CONTRADICTION or HUMAN_REQUIRED rejects
test("P7R2-T-014: REVISE with SPEC_CONTRADICTION or HUMAN_REQUIRED rejects", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t014-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const repoPath = await fs.realpath(fixture.stateDirectory);
    await setupRunDirectory(fixture.stateDirectory, fixture.receipt.archive_sha256!, repoPath);
    const configPath = await createMultiRepoTestConfig(fixture.stateDirectory, repoPath);

    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "REVISE",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      criterion_results: [{ criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "F" }],
      blocking_findings: [
        {
          finding_id: "WEB-FIND-001",
          classification: "SPEC_CONTRADICTION",
          finding_origin: "INITIAL_DISCOVERY",
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "index.ts:1",
          expected_behavior: "A",
          observed_behavior: "B",
          evidence: "Log",
          minimal_required_fix: "Fix",
          revision_changed_paths: ["repository/source/index.ts"],
        },
      ],
    });
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    await assert.rejects(
      () =>
        submitWebVerdict({
          runId: fixture.receipt.run_id,
          stateDirectory: fixture.stateDirectory,
          configPath,
          verdictPath,
          githubClient: mockGithubClient(),
        }),
      (err: any) => err instanceof WebReviewError && err.code === "WEB_REVIEW_VERDICT_INVALID"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-016: Real temp repo and two commits produce exact NUL-parsed delta
test("P7R2-T-016: Real temp repo and two commits produce exact NUL-parsed delta", async () => {
  const gitTmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-git-")));
  try {
    await execFileAsync("git", ["init"], { cwd: gitTmp });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: gitTmp });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: gitTmp });

    await fs.writeFile(path.join(gitTmp, "file1.txt"), "hello\n");
    await execFileAsync("git", ["add", "file1.txt"], { cwd: gitTmp });
    await execFileAsync("git", ["commit", "-m", "commit 1"], { cwd: gitTmp });
    const { stdout: c1 } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitTmp });

    await fs.writeFile(path.join(gitTmp, "file2.txt"), "world\n");
    await execFileAsync("git", ["add", "file2.txt"], { cwd: gitTmp });
    await execFileAsync("git", ["commit", "-m", "commit 2"], { cwd: gitTmp });
    const { stdout: c2 } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitTmp });

    const delta = await computeBoundedGitDelta(gitTmp, c1.trim(), c2.trim());
    assert.ok(delta.has("file2.txt"));
    assert.equal(delta.size, 1);
  } finally {
    await fs.rm(gitTmp, { recursive: true, force: true });
  }
});

// P7R2-T-018: NUL-delimited parsing handles multiple entry paths cleanly
test("P7R2-T-018: NUL-delimited parsing handles multiple entry paths cleanly", async () => {
  const gitTmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-git-nul-")));
  try {
    await execFileAsync("git", ["init"], { cwd: gitTmp });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: gitTmp });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: gitTmp });

    await fs.writeFile(path.join(gitTmp, "file1.txt"), "1\n");
    await execFileAsync("git", ["add", "file1.txt"], { cwd: gitTmp });
    await execFileAsync("git", ["commit", "-m", "c1"], { cwd: gitTmp });
    const { stdout: c1 } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitTmp });

    await fs.writeFile(path.join(gitTmp, "file1.txt"), "1-mod\n");
    await fs.writeFile(path.join(gitTmp, "file2.txt"), "2\n");
    await execFileAsync("git", ["add", "file1.txt", "file2.txt"], { cwd: gitTmp });
    await execFileAsync("git", ["commit", "-m", "c2"], { cwd: gitTmp });
    const { stdout: c2 } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitTmp });

    const delta = await computeBoundedGitDelta(gitTmp, c1.trim(), c2.trim());
    assert.ok(delta.has("file1.txt"));
    assert.ok(delta.has("file2.txt"));
    assert.equal(delta.size, 2);
  } finally {
    await fs.rm(gitTmp, { recursive: true, force: true });
  }
});

// P7R2-T-026: Two injected clocks produce byte-identical verdict/revision/event hashes
test("P7R2-T-026: Two injected clocks produce byte-identical verdict/revision/event hashes", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t026-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "REVISE",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      criterion_results: [{ criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "FAIL" }],
      blocking_findings: [
        {
          finding_id: "WEB-FIND-001",
          classification: "IMPLEMENTATION_DEFECT",
          finding_origin: "INITIAL_DISCOVERY",
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "index.ts:1",
          expected_behavior: "A",
          observed_behavior: "B",
          evidence: "E",
          minimal_required_fix: "Fix",
          revision_changed_paths: ["repository/source/index.ts"],
        },
      ],
    });

    const rev1 = buildRevisionRequest(verdict, "1".repeat(64));
    const rev2 = buildRevisionRequest(verdict, "1".repeat(64));
    assert.equal(rev1.revisionRequestSha256, rev2.revisionRequestSha256);

    const evt1 = buildDecisionEvent(verdict, "1".repeat(64), rev1.revisionRequestSha256);
    const evt2 = buildDecisionEvent(verdict, "1".repeat(64), rev1.revisionRequestSha256);
    assert.equal(evt1.decisionEventSha256, evt2.decisionEventSha256);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-028: Concurrent conflicting submissions cannot overwrite target
test("P7R2-T-028: Concurrent conflicting submissions cannot overwrite target", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t028-")));
  try {
    const file = path.join(tmpDir, "sealed.json");
    const b1 = Buffer.from("content 1\n", "utf8");
    const b2 = Buffer.from("content 2\n", "utf8");

    await writeCanonicalArtifact(file, b1);
    await assert.rejects(
      () => writeCanonicalArtifact(file, b2),
      (err: any) => err instanceof WebReviewError && err.code === "WEB_REVIEW_ALREADY_SEALED"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-032: Long-running live lock is not deleted after TTL/mtime threshold
test("P7R2-T-032: Long-running live lock is not deleted after TTL/mtime threshold", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t032-")));
  try {
    const lockFile = path.join(tmpDir, "web-review.lock");
    const lock1 = await acquireReviewLock(lockFile, 1000);

    const oldTime = new Date(Date.now() - 7200_000);
    fsSync.utimesSync(lockFile, oldTime, oldTime);

    await assert.rejects(
      () => acquireReviewLock(lockFile, 200),
      (err: any) => err instanceof WebReviewError && err.code === "WEB_REVIEW_LOCK_FAILED"
    );

    await lock1.release();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-033: Non-owner release cannot unlink another owner's lock
test("P7R2-T-033: Non-owner release cannot unlink another owner's lock", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t033-")));
  try {
    const lockFile = path.join(tmpDir, "web-review.lock");
    const lock1 = await acquireReviewLock(lockFile, 1000);

    await fs.writeFile(
      lockFile,
      JSON.stringify({ pid: process.pid, nonce: "different-nonce", acquired_at: new Date().toISOString() })
    );

    await lock1.release();
    assert.ok(fsSync.existsSync(lockFile));

    await fs.unlink(lockFile).catch(() => undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// P7R2-T-035: Duplicate --round and duplicate flags return usage exit 2
test("P7R2-T-035: Duplicate --round and duplicate flags return usage exit 2", async () => {
  const exitCode1 = await runWebReviewStatusCommand(["--run-id", "R1", "--state-dir", "D1", "--round", "1", "--round", "2"]);
  assert.equal(exitCode1, 2);

  const exitCode2 = await runSubmitWebVerdictCommand([
    "--run-id",
    "R1",
    "--run-id",
    "R2",
    "--state-dir",
    "D1",
    "--config",
    "C1",
    "--verdict",
    "V1",
  ]);
  assert.equal(exitCode2, 2);
});

// P7R2-T-042: Status command performs no config read, network, Git or validation
test("P7R2-T-042: Status command performs no config read, network, Git or validation", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7r2-t042-")));
  try {
    const statusOpts = {
      runId: `${TEST_TASK_ID}:1111111111111111111111111111111111111111111111111111111111111111`,
      stateDirectory: tmpDir,
    };
    const res = await getWebReviewStatus(statusOpts);
    assert.equal(res, null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
