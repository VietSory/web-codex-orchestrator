import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRevisionRoundPaths, prepareRevisionRoundPaths } from "../src/revision/revision-paths.js";
import { acquireRevisionLock } from "../src/revision/revision-lock.js";
import { assertRevisionRequest, loadSealedRevisionSource } from "../src/revision/revision-source.js";
import { attestRevisionPullRequest } from "../src/revision/revision-github-attestation.js";
import { RevisionError } from "../src/revision/contracts.js";
import { loadAndVerifyResultBundle } from "../src/web-review/result-bundle-review-reader.js";
import { submitWebVerdict } from "../src/web-review/web-review-service.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";
import {
  createPhase6BundleFixture,
  createValidVerdict,
  TEST_BASE_COMMIT,
  TEST_PUBLISHED_COMMIT,
} from "./helpers/phase7-fixtures.js";

function githubClient(overrides?: Record<string, unknown>): GitHubAttestationClient {
  return {
    async getPullRequest(owner: string, repo: string, prNumber: number) {
      return {
        number: prNumber,
        state: "open",
        draft: true,
        merged: false,
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        head: { ref: "codex/feature", sha: TEST_PUBLISHED_COMMIT, repo: { full_name: `${owner}/${repo}` } },
        base: { ref: "main", sha: TEST_BASE_COMMIT, repo: { full_name: `${owner}/${repo}` } },
        ...overrides,
      };
    },
  };
}

async function writeConfig(stateDir: string): Promise<string> {
  const file = path.join(stateDir, "phase8-config.json");
  await fs.writeFile(file, JSON.stringify({
    config_version: "1.0",
    inbox: { poll_interval_ms: 1000, stable_age_ms: 1000, stable_observations: 1, maximum_candidates_per_scan: 1 },
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
      authentication: { mode: "https_token", token_environment_key: "WCO_GITHUB_TOKEN" },
    },
  }));
  return fs.realpath(file);
}

function reviseVerdict(receipt: Awaited<ReturnType<typeof createPhase6BundleFixture>>["receipt"]) {
  return createValidVerdict(receipt, {
    verdict: "REVISE",
    summary: "One implementation defect must be corrected.",
    comprehensive_review_complete: true,
    criterion_results: [{ criterion_id: "AC-1", required: true, status: "FAIL", evidence_refs: ["repository/source/index.ts"], notes: "Needs correction" }],
    blocking_findings: [{
      finding_id: "WEB-FIND-001",
      classification: "IMPLEMENTATION_DEFECT",
      finding_origin: "INITIAL_DISCOVERY",
      previous_finding_id: null,
      locked_reference_ids: ["AC-1"],
      artifact_paths: ["repository/source/index.ts"],
      line_or_json_pointer: "1",
      expected_behavior: "AC-1 must be satisfied.",
      observed_behavior: "The current implementation does not satisfy AC-1.",
      evidence: "Current implementation does not satisfy AC-1.",
      minimal_required_fix: "Correct the implementation without changing the frozen contract.",
      revision_changed_paths: [],
    }],
  });
}

test("P8-FND-001: review round 2 never falls back to initial Phase 6 Result Bundle", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-round-select-")));
  try {
    const fixture = await createPhase6BundleFixture(root);
    await assert.rejects(
      () => loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id, 2),
      (error: unknown) => error instanceof Error && error.message.includes("revision 1") && error.message.includes("not found")
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("P8-FND-002: revision lifecycle symlink ancestor is rejected", { skip: process.platform === "win32" }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-path-")));
  try {
    const state = path.join(root, "state");
    const outside = path.join(root, "outside");
    await fs.mkdir(state);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(state, "revisions"));
    const paths = resolveRevisionRoundPaths(state, `TASK:${"1".repeat(64)}`, 1);
    await assert.rejects(
      () => prepareRevisionRoundPaths(state, paths),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_STATE_UNSAFE"
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("P8-FND-003: stale revision lock is not auto-stolen", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-lock-")));
  try {
    const lockPath = path.join(root, "revision.lock");
    const bytes = JSON.stringify({ pid: 2_147_483_647, nonce: "old", acquired_at: "2026-01-01T00:00:00.000Z" }) + "\n";
    await fs.writeFile(lockPath, bytes);
    await assert.rejects(
      () => acquireRevisionLock(lockPath, 75),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_LOCKED" && error.message.includes("operator recovery")
    );
    assert.equal(await fs.readFile(lockPath, "utf8"), bytes);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("P8-FND-004: revision request validator rejects unknown authority fields", () => {
  const request = {
    schema_version: "1.1",
    run_id: `TASK:${"1".repeat(64)}`,
    revision_round: 1,
    spec_set_sha256: "2".repeat(64),
    previous_result_bundle_sha256: "3".repeat(64),
    previous_verdict_sha256: "4".repeat(64),
    previous_published_commit_sha: "5".repeat(40),
    previous_pr_head_sha: "5".repeat(40),
    pull_request_number: 1,
    findings: [{
      finding_id: "WEB-FIND-001",
      classification: "IMPLEMENTATION_DEFECT",
      finding_origin: "INITIAL_DISCOVERY",
      locked_reference_ids: ["AC-1"],
      artifact_paths: ["repository/source/index.ts"],
      line_or_json_pointer: "1",
      evidence: "evidence",
      minimal_required_fix: "fix",
    }],
    loose_patch: "forbidden",
  };
  assert.throws(() => assertRevisionRequest(request), (error: unknown) => error instanceof RevisionError && error.code === "REVISION_REQUEST_INVALID");
});

test("P8-FND-005: strict revision PR attestation rejects a PR marked Ready", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-pr-")));
  try {
    const configPath = await writeConfig(root);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    await assert.rejects(
      () => attestRevisionPullRequest({
        expected: {
          pullRequestUrl: "https://github.com/owner/repo/pull/101",
          pullRequestNumber: 101,
          headBranch: "codex/feature",
          headSha: TEST_PUBLISHED_COMMIT,
          baseBranch: "main",
          baseSha: TEST_BASE_COMMIT,
        },
        config,
        githubClient: githubClient({ draft: false }),
      }),
      (error: unknown) => error instanceof RevisionError && error.code === "REVISION_PR_DRIFT"
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("P8-FND-006: Phase 8 reconstructs a sealed Phase 7 REVISE handoff", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p8-source-")));
  try {
    const fixture = await createPhase6BundleFixture(root);
    const configPath = await writeConfig(fixture.stateDirectory);
    const verdict = reviseVerdict(fixture.receipt);
    const verdictPath = path.join(root, "revise.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    const receipt = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
      githubClient: githubClient(),
    });
    assert.equal(receipt.state, "REVISION_REQUESTED");

    const source = await loadSealedRevisionSource(fixture.stateDirectory, fixture.receipt.run_id, 1);
    assert.equal(source.request.revision_round, 1);
    assert.equal(source.request.previous_result_bundle_sha256, fixture.receipt.archive_sha256);
    assert.equal(source.request.previous_published_commit_sha, fixture.receipt.published_commit_sha);
    assert.equal(source.request.findings.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
