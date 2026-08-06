import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { submitWebVerdict, getWebReviewStatus } from "../src/web-review/web-review-service.js";
import { buildRevisionRequest } from "../src/web-review/revision-request-builder.js";
import { createPhase6BundleFixture, createValidVerdict, TEST_PUBLISHED_COMMIT, TEST_BASE_COMMIT, TEST_SPEC_SET_SHA } from "./helpers/phase7-fixtures.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";

function mockGithubClient(overrides?: Partial<any>): GitHubAttestationClient {
  return {
    async getPullRequest(owner: string, repo: string, prNumber: number) {
      return {
        number: prNumber,
        state: "open",
        head: { ref: "codex/feature", sha: TEST_PUBLISHED_COMMIT, repo: { full_name: `${owner}/${repo}` } },
        base: { ref: "main", sha: TEST_BASE_COMMIT, repo: { full_name: `${owner}/${repo}` } },
        merged: false,
        ...overrides,
      } as any;
    },
  } as GitHubAttestationClient;
}

async function createTestConfig(stateDir: string): Promise<string> {
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
        repo: {
          path: stateDir,
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

test("P7-REM-001: buildRevisionRequest aligns strictly with schema 1.1 (no extra fields)", () => {
  const verdict: any = {
    schema_version: "1.1",
    kind: "wco-web-review-verdict",
    run_id: "RUN:123",
    review_round: 1,
    review_mode: "INITIAL",
    spec_set_sha256: TEST_SPEC_SET_SHA,
    result_bundle_sha256: "1".repeat(64),
    manifest_sha256: "f".repeat(64),
    reviewed_entry_set_sha256: "f".repeat(64),
    published_commit_sha: TEST_PUBLISHED_COMMIT,
    pull_request_number: 101,
    observed_head_sha: TEST_PUBLISHED_COMMIT,
    verdict: "REVISE",
    comprehensive_review_complete: true,
    criterion_results: [{ criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/acceptance.json"], notes: "AC-1 failed" }],
    blocking_findings: [
      {
        finding_id: "WEB-FIND-001",
        classification: "IMPLEMENTATION_DEFECT",
        finding_origin: "INITIAL_DISCOVERY",
        locked_reference_ids: ["AC-1"],
        artifact_paths: ["repository/source/index.ts"],
        line_or_json_pointer: "index.ts:10",
        expected_behavior: "Return 200",
        observed_behavior: "Returns 500",
        evidence: "Console stack trace",
        minimal_required_fix: "Fix handler return code",
        revision_changed_paths: ["repository/source/index.ts"],
      },
    ],
    non_blocking_backlog: [],
    previous_result_bundle_sha256: null,
    previous_verdict_sha256: null,
    previous_published_commit_sha: null,
    previous_pr_head_sha: null,
    revision_request_sha256: null,
  };

  const built = buildRevisionRequest(verdict, "0".repeat(64));
  assert.equal((built.revisionRequest as any).kind, undefined);
  assert.equal((built.revisionRequest.findings[0] as any).expected_behavior, undefined);
  assert.equal((built.revisionRequest.findings[0] as any).observed_behavior, undefined);
  assert.equal((built.revisionRequest.findings[0] as any).revision_changed_paths, undefined);
  assert.equal(built.revisionRequest.schema_version, "1.1");
  assert.equal(built.revisionRequest.findings.length, 1);
});

test("P7-REM-002: submitWebVerdict happy path for REVISE creates revision-request.json and transitions to REVISION_REQUESTED", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-rem-002-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);

    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    const verdict = createValidVerdict(fixture.receipt, {
      verdict: "REVISE",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      criterion_results: [{ criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "AC-1 failed" }],
      blocking_findings: [
        {
          finding_id: "WEB-FIND-001",
          classification: "IMPLEMENTATION_DEFECT",
          finding_origin: "INITIAL_DISCOVERY",
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "index.ts:10",
          expected_behavior: "Return 200",
          observed_behavior: "Returns 500",
          evidence: "Log trace",
          minimal_required_fix: "Fix status code",
          revision_changed_paths: ["repository/source/index.ts"],
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

    assert.equal(receipt.state, "REVISION_REQUESTED");
    assert.equal(receipt.action, "NO_USER_MERGE_PROMPT");
    assert.ok(receipt.revision_request_sha256);
    assert.ok(receipt.artifact_paths.revision_request);

    const revReqPath = path.join(fixture.stateDirectory, receipt.artifact_paths.revision_request!);
    const revReqRaw = await fs.readFile(revReqPath, "utf8");
    const revReqJson = JSON.parse(revReqRaw);
    assert.equal(revReqJson.schema_version, "1.1");
    assert.equal(revReqJson.findings.length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-REM-003: missing GitHub token fails closed with WEB_REVIEW_AUTH_ERROR", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-rem-003-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);

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

test("P7-REM-004: GitHub head/base drift rejects with WEB_REVIEW_REPOSITORY_DRIFT", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-rem-004-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);

    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    // Client returns head branch drift
    const driftingClient = mockGithubClient({ head: { ref: "wrong-branch", sha: TEST_PUBLISHED_COMMIT } });

    await assert.rejects(
      () =>
        submitWebVerdict({
          runId: fixture.receipt.run_id,
          stateDirectory: fixture.stateDirectory,
          configPath,
          verdictPath,
          githubClient: driftingClient,
        }),
      (err: any) => err instanceof WebReviewError && err.code === "WEB_REVIEW_REPOSITORY_DRIFT"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-REM-005: INITIAL_DISCOVERY origin in round 2 is rejected as anti-drip violation", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-rem-005-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);

    // Create Round 1 verdict & receipt
    const r1VerdictPath = path.join(fixture.stateDirectory, "r1-verdict.json");
    const r1Verdict = createValidVerdict(fixture.receipt, {
      verdict: "REVISE",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      criterion_results: [{ criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "Failed" }],
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
    await fs.writeFile(r1VerdictPath, JSON.stringify(r1Verdict));

    const r1Receipt = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath: r1VerdictPath,
      githubClient: mockGithubClient(),
    });

    // Create Round 2 verdict with forbidden INITIAL_DISCOVERY origin
    const r2VerdictPath = path.join(fixture.stateDirectory, "r2-verdict.json");
    const r2Verdict = createValidVerdict(fixture.receipt, {
      review_round: 2,
      review_mode: "REVISION",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      previous_result_bundle_sha256: fixture.receipt.archive_sha256!,
      previous_verdict_sha256: r1Receipt.verdict_sha256!,
      previous_published_commit_sha: TEST_PUBLISHED_COMMIT,
      revision_request_sha256: r1Receipt.revision_request_sha256!,
      verdict: "REVISE",
      criterion_results: [{ criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "Failed" }],
      blocking_findings: [
        {
          finding_id: "WEB-FIND-002",
          classification: "IMPLEMENTATION_DEFECT",
          finding_origin: "INITIAL_DISCOVERY", // FORBIDDEN IN ROUND 2
          previous_finding_id: null,
          locked_reference_ids: ["AC-1"],
          artifact_paths: ["repository/source/index.ts"],
          line_or_json_pointer: "index.ts:5",
          expected_behavior: "A",
          observed_behavior: "B",
          evidence: "E",
          minimal_required_fix: "Fix",
          revision_changed_paths: [],
        },
      ],
    });
    await fs.writeFile(r2VerdictPath, JSON.stringify(r2Verdict));

    await assert.rejects(
      () =>
        submitWebVerdict({
          runId: fixture.receipt.run_id,
          stateDirectory: fixture.stateDirectory,
          configPath,
          verdictPath: r2VerdictPath,
          githubClient: mockGithubClient(),
        }),
      (err: any) => err instanceof WebReviewError && (err.code === "WEB_REVIEW_ANTI_DRIP_VIOLATION" || err.code === "WEB_REVIEW_VERDICT_INVALID")
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-REM-006: missing or tampered previous artifacts reject revision round with WEB_REVIEW_HISTORY_INVALID", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-rem-006-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);

    // Create Round 1 verdict & receipt
    const r1VerdictPath = path.join(fixture.stateDirectory, "r1-verdict.json");
    const r1Verdict = createValidVerdict(fixture.receipt, {
      verdict: "REVISE",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      criterion_results: [{ criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["evidence/execution.json"], notes: "Failed" }],
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
    await fs.writeFile(r1VerdictPath, JSON.stringify(r1Verdict));

    const r1Receipt = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath: r1VerdictPath,
      githubClient: mockGithubClient(),
    });

    // Tamper with round 1 verdict on disk
    const diskR1VerdictPath = path.join(fixture.stateDirectory, r1Receipt.artifact_paths.verdict!);
    await fs.writeFile(diskR1VerdictPath, JSON.stringify({ tampered: true }));

    // Create Round 2 verdict
    const r2VerdictPath = path.join(fixture.stateDirectory, "r2-verdict.json");
    const r2Verdict = createValidVerdict(fixture.receipt, {
      review_round: 2,
      review_mode: "REVISION",
      observed_head_sha: TEST_PUBLISHED_COMMIT,
      previous_result_bundle_sha256: fixture.receipt.archive_sha256!,
      previous_verdict_sha256: r1Receipt.verdict_sha256!,
      previous_published_commit_sha: TEST_PUBLISHED_COMMIT,
      revision_request_sha256: r1Receipt.revision_request_sha256!,
      verdict: "APPROVE",
      comprehensive_review_complete: true,
      criterion_results: [{ criterion_id: "AC-1", required: true, status: "PASS", evidence_refs: ["evidence/execution.json"], notes: "Fixed" }],
      blocking_findings: [],
    });
    await fs.writeFile(r2VerdictPath, JSON.stringify(r2Verdict));

    await assert.rejects(
      () =>
        submitWebVerdict({
          runId: fixture.receipt.run_id,
          stateDirectory: fixture.stateDirectory,
          configPath,
          verdictPath: r2VerdictPath,
          githubClient: mockGithubClient(),
        }),
      (err: any) => err instanceof WebReviewError && err.code === "WEB_REVIEW_HISTORY_INVALID"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-REM-007: submitWebVerdict happy paths for APPROVE and ESCALATE", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-rem-007-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);

    // APPROVE
    const approveVerdictPath = path.join(fixture.stateDirectory, "approve-verdict.json");
    const approveVerdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    await fs.writeFile(approveVerdictPath, JSON.stringify(approveVerdict));

    const approveReceipt = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath: approveVerdictPath,
      githubClient: mockGithubClient(),
    });

    assert.equal(approveReceipt.state, "APPROVED");
    assert.equal(approveReceipt.action, "ASK_USER_TO_MERGE");
    assert.ok(approveReceipt.decision_event_sha256);

    const status = await getWebReviewStatus({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
    });
    assert.equal(status?.state, "APPROVED");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
