// Test fixtures and helpers for Phase 7 Web Review Verdict Processing tests
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../../src/result-bundle/canonical-json.js";
import { buildDeterministicZip } from "../../src/result-bundle/deterministic-zip.js";
import type { ResultBundleReceipt } from "../../src/result-bundle/contracts.js";
import type { WebReviewVerdict } from "../../src/result-bundle/web-verdict-validator.js";

export function sha256Hex(buf: Buffer | string): string {
  const input = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return crypto.createHash("sha256").update(input).digest("hex");
}

export const TEST_RUN_ID = "TEST-TASK:1111111111111111111111111111111111111111111111111111111111111111";
export const TEST_TASK_ID = "TEST-TASK";
export const TEST_ARCHIVE_SHA = "1111111111111111111111111111111111111111111111111111111111111111";
export const TEST_PUBLISHED_COMMIT = "a".repeat(40);
export const TEST_HEAD_SHA = "b".repeat(40);
export const TEST_BASE_COMMIT = "c".repeat(40);
export const TEST_SPEC_SET_SHA = "d".repeat(64);

export interface CreatedPhase6BundleFixture {
  stateDirectory: string;
  receiptPath: string;
  archivePath: string;
  receipt: ResultBundleReceipt;
  entries: { path: string; content: Buffer }[];
}

export async function createPhase6BundleFixture(
  tmpDir: string,
  overrides?: Partial<ResultBundleReceipt>,
  entryOverrides?: Record<string, Buffer>
): Promise<CreatedPhase6BundleFixture> {
  const stateDirectory = path.resolve(tmpDir);
  const tempBuildDir = path.join(stateDirectory, "tmp-build");
  await fs.mkdir(tempBuildDir, { recursive: true });

  const rawEntries: { path: string; content: Buffer }[] = [
    { path: "RESULT.md", content: Buffer.from("# Result\n", "utf8") },
    { path: "REVIEW.md", content: Buffer.from("# Review\n", "utf8") },
    { path: "checksums.json", content: Buffer.from(JSON.stringify({}), "utf8") },
    { path: "evidence/acceptance.json", content: Buffer.from(JSON.stringify({ schema_version: "1.1", status: "PASS" }), "utf8") },
    { path: "evidence/event-summary.json", content: Buffer.from(JSON.stringify({ status: "PASS" }), "utf8") },
    { path: "evidence/execution.json", content: Buffer.from(JSON.stringify({ task_id: TEST_TASK_ID }), "utf8") },
    { path: "evidence/git-publish.json", content: Buffer.from(JSON.stringify({ commit: TEST_PUBLISHED_COMMIT }), "utf8") },
    { path: "evidence/github-draft-pr.json", content: Buffer.from(JSON.stringify({ pull_request_number: 101 }), "utf8") },
    { path: "evidence/sol-review.json", content: Buffer.from(JSON.stringify({ verdict: "APPROVE" }), "utf8") },
    { path: "evidence/terra-review.json", content: Buffer.from(JSON.stringify({ verdict: "APPROVE" }), "utf8") },
    { path: "evidence/verification.json", content: Buffer.from(JSON.stringify({ status: "PASS" }), "utf8") },
    { path: "github/pull-request.json", content: Buffer.from(JSON.stringify({ number: 101, draft: true }), "utf8") },
    { path: "repository/changed-files.json", content: Buffer.from(JSON.stringify(["repository/source/index.ts"]), "utf8") },
    { path: "repository/deleted-files.json", content: Buffer.from(JSON.stringify([]), "utf8") },
    { path: "repository/diff.patch", content: Buffer.from("", "utf8") },
    { path: "repository/source/index.ts", content: Buffer.from("console.log('hello');\n", "utf8") },
    { path: "review/WEB-REVIEW-CONTRACT.md", content: Buffer.from("# Web Review Contract\n", "utf8") },
    { path: "review/revision-request.schema.json", content: Buffer.from(JSON.stringify({ version: "1.1" }), "utf8") },
    { path: "review/web-review-policy.json", content: Buffer.from(JSON.stringify({ version: "1.0" }), "utf8") },
    { path: "review/web-review-verdict.schema.json", content: Buffer.from(JSON.stringify({ version: "1.1" }), "utf8") },
    { path: "task/PLAN.md", content: Buffer.from("# Plan\n", "utf8") },
    { path: "task/README.md", content: Buffer.from("# Task README\n", "utf8") },
    { path: "task/REQUEST.md", content: Buffer.from("# Request\n", "utf8") },
    { path: "task/RESEARCH.md", content: Buffer.from("# Research\n", "utf8") },
    { path: "task/RULES.md", content: Buffer.from("# Rules\n", "utf8") },
    { path: "task/SOURCES.md", content: Buffer.from("# Sources\n", "utf8") },
    { path: "task/VALIDATION.md", content: Buffer.from("# Validation\n", "utf8") },
    { path: "task/acceptance.json", content: Buffer.from(JSON.stringify({ schema_version: "1.1", criteria: [{ id: "AC-1", description: "First criterion" }] }), "utf8") },
    { path: "task/checksums.json", content: Buffer.from(JSON.stringify({}), "utf8") },
    { path: "task/manifest.json", content: Buffer.from(JSON.stringify({ task_id: TEST_TASK_ID }), "utf8") },
    { path: "task/risk-policy.json", content: Buffer.from(JSON.stringify({ schema_version: "1.0", risk_level: "LOW" }), "utf8") },
    { path: "task/spec-lock.json", content: Buffer.from(JSON.stringify({ spec_set_sha256: TEST_SPEC_SET_SHA }), "utf8") },
    { path: "task/test-matrix.json", content: Buffer.from(JSON.stringify({ schema_version: "1.1", cases: [{ id: "TC-1", description: "First test case" }] }), "utf8") },
    { path: "task/validation.json", content: Buffer.from(JSON.stringify({ schema_version: "1.1", commands: [{ id: "VAL-1", command: "npm test" }] }), "utf8") },
  ];

  if (entryOverrides) {
    for (const [entryPath, content] of Object.entries(entryOverrides)) {
      const existing = rawEntries.find((entry) => entry.path === entryPath);
      if (existing) existing.content = content;
      else rawEntries.push({ path: entryPath, content });
    }
  }

  rawEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entryByPath = new Map(rawEntries.map((entry) => [entry.path, entry.content] as const));
  const reviewContractSha = sha256Hex(entryByPath.get("review/WEB-REVIEW-CONTRACT.md")!);
  const revisionRequestSchemaSha = sha256Hex(entryByPath.get("review/revision-request.schema.json")!);
  const reviewPolicySha = sha256Hex(entryByPath.get("review/web-review-policy.json")!);
  const verdictSchemaSha = sha256Hex(entryByPath.get("review/web-review-verdict.schema.json")!);

  const manifestEntryList = rawEntries.map((e) => ({
    path: e.path,
    sha256: sha256Hex(e.content),
    size_bytes: e.content.byteLength,
  }));
  const reviewedEntrySetSha256 = sha256Hex(canonicalJsonBuffer(manifestEntryList));

  const manifestObj = {
    schema_version: "1.1",
    kind: "wco-result-bundle",
    run_id: TEST_RUN_ID,
    archive_filename: "result-bundle.zip",
    published_commit_sha: TEST_PUBLISHED_COMMIT,
    base_commit: TEST_BASE_COMMIT,
    change_set_sha256: "e".repeat(64),
    pull_request_number: 101,
    task_id: TEST_TASK_ID,
    created_at: "2026-02-15T08:00:00.000Z",
    spec_set_sha256: TEST_SPEC_SET_SHA,
    review_contract_sha256: reviewContractSha,
    review_policy_sha256: reviewPolicySha,
    verdict_schema_sha256: verdictSchemaSha,
    revision_request_schema_sha256: revisionRequestSchemaSha,
    reviewed_entry_set_sha256: reviewedEntrySetSha256,
    entries: manifestEntryList,
  };
  const manifestContent = canonicalJsonBuffer(manifestObj);
  const manifestSha256 = sha256Hex(manifestContent);

  const allEntries = [
    ...rawEntries,
    { path: "manifest.json", content: manifestContent },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const zipRes = await buildDeterministicZip(allEntries, tempBuildDir, "result-bundle.zip", {
    maximumEntries: 1000,
    maximumArchiveBytes: 100_000_000,
    maximumTotalUncompressedBytes: 100_000_000,
  });

  const fixtureRunId = TEST_RUN_ID;
  const handoffDir = path.join(stateDirectory, "handoff", "runs", TEST_TASK_ID, TEST_ARCHIVE_SHA);
  await fs.mkdir(handoffDir, { recursive: true });

  const archivePath = path.join(handoffDir, "result-bundle.zip");
  await fs.rename(zipRes.archivePath, archivePath);
  await fs.rm(tempBuildDir, { recursive: true, force: true }).catch(() => undefined);

  const receiptPath = path.join(handoffDir, "result-bundle.json");
  const receipt: ResultBundleReceipt = {
    result_bundle_version: "1.1",
    run_id: fixtureRunId,
    state: "READY_FOR_WEB_REVIEW",
    input_digest_sha256: "a".repeat(64),
    execution_receipt_sha256: "b".repeat(64),
    git_publish_receipt_sha256: "c".repeat(64),
    draft_pr_receipt_sha256: "d".repeat(64),
    accepted_bundle_tree_sha256: "e".repeat(64),
    change_set_sha256: "e".repeat(64),
    spec_set_sha256: TEST_SPEC_SET_SHA,
    review_contract_sha256: reviewContractSha,
    review_policy_sha256: reviewPolicySha,
    verdict_schema_sha256: verdictSchemaSha,
    revision_request_schema_sha256: revisionRequestSchemaSha,
    reviewed_entry_set_sha256: reviewedEntrySetSha256,
    base_commit: TEST_BASE_COMMIT,
    published_commit_sha: TEST_PUBLISHED_COMMIT,
    remote_branch_sha: TEST_PUBLISHED_COMMIT,
    pull_request: {
      number: 101,
      url: "https://github.com/owner/repo/pull/101",
      state: "open",
      draft: true,
      head_branch: "codex/feature",
      head_sha: TEST_PUBLISHED_COMMIT,
      base_branch: "main",
      title_sha256: "f".repeat(64),
    },
    archive_relative_path: path.relative(stateDirectory, archivePath).replace(/\\/g, "/"),
    archive_sha256: zipRes.sha256,
    archive_size_bytes: zipRes.sizeBytes,
    entry_count: allEntries.length,
    uncompressed_size_bytes: zipRes.uncompressedBytes,
    manifest_sha256: manifestSha256,
    warnings: [],
    created_at: "2026-02-15T08:00:00.000Z",
    updated_at: "2026-02-15T08:00:00.000Z",
    built_at: "2026-02-15T08:00:00.000Z",
    verified_at: "2026-02-15T08:00:00.000Z",
    ready_at: "2026-02-15T08:00:00.000Z",
    ...overrides,
  };

  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");

  const runsDir = path.join(stateDirectory, "runs", TEST_TASK_ID, TEST_ARCHIVE_SHA);
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(
    path.join(runsDir, "run.json"),
    JSON.stringify({
      run_version: "1.0",
      run_id: fixtureRunId,
      status: "READY_FOR_CODEX",
      task_id: TEST_TASK_ID,
      archive_sha256: TEST_ARCHIVE_SHA,
      bundle_schema_version: "1.3",
      repository_id: "repo",
      repository_path: stateDirectory,
      remote: "origin",
      remote_url: "https://github.com/owner/repo",
      base_branch: "main",
      base_commit: TEST_BASE_COMMIT,
      branch_name: "codex/feature",
      worktree_path: path.join(stateDirectory, "worktrees", TEST_TASK_ID),
      accepted_bundle_path: path.join(stateDirectory, "accepted", TEST_TASK_ID, TEST_ARCHIVE_SHA),
      state: "READY_FOR_CODEX",
      checks: ["remote-verified"],
      errors: [],
      created_at: "2026-02-15T08:00:00.000Z",
      updated_at: "2026-02-15T08:00:00.000Z",
      ready_at: "2026-02-15T08:00:00.000Z"
    })
  );

  return {
    stateDirectory,
    receiptPath,
    archivePath,
    receipt,
    entries: allEntries,
  };
}

export function createValidVerdict(
  receipt: ResultBundleReceipt,
  overrides?: Partial<WebReviewVerdict>
): WebReviewVerdict {
  return {
    schema_version: "1.1",
    review_contract_version: "1.1",
    review_policy_version: "1.0",
    run_id: receipt.run_id,
    spec_set_sha256: receipt.spec_set_sha256!,
    result_bundle_sha256: receipt.archive_sha256!,
    manifest_sha256: receipt.manifest_sha256!,
    reviewed_entry_set_sha256: receipt.reviewed_entry_set_sha256!,
    published_commit_sha: receipt.published_commit_sha,
    pull_request_number: receipt.pull_request.number,
    observed_head_sha: receipt.pull_request.head_sha,
    review_mode: "INITIAL",
    review_round: 1,
    previous_result_bundle_sha256: null,
    previous_verdict_sha256: null,
    previous_published_commit_sha: null,
    revision_request_sha256: null,
    verdict: "APPROVE",
    summary: "All acceptance criteria verified successfully.",
    comprehensive_review_complete: true,
    criterion_results: [
      {
        criterion_id: "AC-1",
        required: true,
        status: "PASS",
        evidence_refs: ["evidence/execution.json"],
        notes: "Verified",
      },
    ],
    blocking_findings: [],
    non_blocking_backlog: [],
    ...overrides,
  };
}
