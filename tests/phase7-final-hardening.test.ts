import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadAndVerifyResultBundle } from "../src/web-review/result-bundle-review-reader.js";
import { submitWebVerdict } from "../src/web-review/web-review-service.js";
import { verifyGitHubAttestation } from "../src/web-review/github-review-attestation.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import {
  createPhase6BundleFixture,
  createValidVerdict,
  TEST_ARCHIVE_SHA,
  TEST_BASE_COMMIT,
  TEST_PUBLISHED_COMMIT,
} from "./helpers/phase7-fixtures.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";

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
  return fs.realpath(configPath);
}

function githubClient(overrides?: Record<string, unknown>): GitHubAttestationClient {
  return {
    async getPullRequest(owner: string, repo: string, prNumber: number) {
      return {
        number: prNumber,
        state: "open",
        merged: false,
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        head: {
          ref: "codex/feature",
          sha: TEST_PUBLISHED_COMMIT,
          repo: { full_name: `${owner}/${repo}` },
        },
        base: {
          ref: "main",
          sha: TEST_BASE_COMMIT,
          repo: { full_name: `${owner}/${repo}` },
        },
        ...overrides,
      } as any;
    },
  } as GitHubAttestationClient;
}

test("P7-FINAL-001: run identity uses Task Bundle SHA while Result Bundle keeps its own archive SHA", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-final-id-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    assert.ok(fixture.receipt.run_id.endsWith(TEST_ARCHIVE_SHA));
    assert.notEqual(fixture.receipt.archive_sha256, TEST_ARCHIVE_SHA);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);
    assert.equal(loaded.receipt.archive_sha256, fixture.receipt.archive_sha256);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-FINAL-002: exact embedded verdict schema can tighten validation and is authoritative", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-final-schema-")));
  try {
    const embeddedSchema = Buffer.from(JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { summary: { const: "EXPECTED-BY-EMBEDDED-SCHEMA" } },
      required: ["summary"],
    }));
    const fixture = await createPhase6BundleFixture(
      tmpDir,
      undefined,
      { "review/web-review-verdict.schema.json": embeddedSchema }
    );
    const configPath = await createTestConfig(fixture.stateDirectory);
    const verdict = createValidVerdict(fixture.receipt, { summary: "built-in schema accepts this summary" });
    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    await assert.rejects(
      () => submitWebVerdict({
        runId: fixture.receipt.run_id,
        stateDirectory: fixture.stateDirectory,
        configPath,
        verdictPath,
        githubClient: githubClient(),
      }),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_VERDICT_INVALID"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-FINAL-003: terminal idempotent retry rejects a tampered decision artifact", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-final-recovery-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);
    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    const receipt = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
      githubClient: githubClient(),
    });
    assert.equal(receipt.state, "APPROVED");
    assert.ok(receipt.artifact_paths.decision_event);
    await fs.writeFile(
      path.join(fixture.stateDirectory, receipt.artifact_paths.decision_event!),
      JSON.stringify({ tampered: true })
    );

    await assert.rejects(
      () => submitWebVerdict({
        runId: fixture.receipt.run_id,
        stateDirectory: fixture.stateDirectory,
        configPath,
        verdictPath,
        githubClient: githubClient(),
      }),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_RECEIPT_INVALID"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-FINAL-004: embedded review contract hash must match the Phase 6 receipt", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-final-hash-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir, {
      review_contract_sha256: "0".repeat(64),
    });
    await assert.rejects(
      () => loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_RESULT_BUNDLE_INVALID"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-FINAL-005: GitHub attestation rejects missing repository identity and base SHA", async () => {
  const receipt: any = {
    base_commit: TEST_BASE_COMMIT,
    published_commit_sha: TEST_PUBLISHED_COMMIT,
    pull_request: {
      number: 101,
      url: "https://github.com/owner/repo/pull/101",
      head_branch: "codex/feature",
      head_sha: TEST_PUBLISHED_COMMIT,
      base_branch: "main",
    },
  };
  const verdict: any = { observed_head_sha: TEST_PUBLISHED_COMMIT };

  const missingRepoClient = githubClient({
    head: { ref: "codex/feature", sha: TEST_PUBLISHED_COMMIT, repo: {} },
  });
  await assert.rejects(
    () => verifyGitHubAttestation({ receipt, config: {} as any, verdict, githubClient: missingRepoClient }),
    (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_REPOSITORY_DRIFT"
  );

  const missingBaseShaClient = githubClient({
    base: { ref: "main", repo: { full_name: "owner/repo" } },
  });
  await assert.rejects(
    () => verifyGitHubAttestation({ receipt, config: {} as any, verdict, githubClient: missingBaseShaClient }),
    (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_REPOSITORY_DRIFT"
  );
});
