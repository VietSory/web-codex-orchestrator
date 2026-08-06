import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { submitWebVerdict, getWebReviewStatus } from "../src/web-review/web-review-service.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, createValidVerdict, TEST_PUBLISHED_COMMIT, TEST_BASE_COMMIT } from "./helpers/phase7-fixtures.js";
import type { GitHubAttestationClient } from "../src/result-bundle/github-attestation.js";

function mockGithubClient(): GitHubAttestationClient {
  return {
    async getPullRequest(owner: string, repo: string, prNumber: number) {
      return {
        number: prNumber,
        state: "open",
        head: { ref: "codex/feature", sha: TEST_PUBLISHED_COMMIT, repo: { full_name: `${owner}/${repo}` } },
        base: { ref: "main", sha: TEST_BASE_COMMIT, repo: { full_name: `${owner}/${repo}` } },
        merged: false,
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

test("PERSIST-001: exact retry of submitWebVerdict is idempotent", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-pers-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);
    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2));

    const receipt1 = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
      githubClient: mockGithubClient(),
    });

    assert.equal(receipt1.state, "APPROVED");

    // Exact retry
    const receipt2 = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
      githubClient: mockGithubClient(),
    });

    assert.equal(receipt2.state, "APPROVED");
    assert.equal(receipt2.verdict_sha256, receipt1.verdict_sha256);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PERSIST-002: conflicting verdict submitted to a sealed round is rejected", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-pers-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);
    const verdict1 = createValidVerdict(fixture.receipt, { summary: "First summary", observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath1 = path.join(fixture.stateDirectory, "verdict1.json");
    await fs.writeFile(verdictPath1, JSON.stringify(verdict1, null, 2));

    await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath: verdictPath1,
      githubClient: mockGithubClient(),
    });

    // Conflicting verdict with different content
    const verdict2 = createValidVerdict(fixture.receipt, { summary: "Different summary", observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath2 = path.join(fixture.stateDirectory, "verdict2.json");
    await fs.writeFile(verdictPath2, JSON.stringify(verdict2, null, 2));

    await assert.rejects(
      () => submitWebVerdict({
        runId: fixture.receipt.run_id,
        stateDirectory: fixture.stateDirectory,
        configPath,
        verdictPath: verdictPath2,
        githubClient: mockGithubClient(),
      }),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_ALREADY_SEALED");
        assert.ok((err as WebReviewError).message.includes("already sealed with a different verdict") || (err as WebReviewError).message.includes("already sealed with different verdict content"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PERSIST-003: getWebReviewStatus is read-only and does not perform validation", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-pers-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createTestConfig(fixture.stateDirectory);
    const verdict = createValidVerdict(fixture.receipt, { observed_head_sha: TEST_PUBLISHED_COMMIT });
    const verdictPath = path.join(fixture.stateDirectory, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2));

    await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
      githubClient: mockGithubClient(),
    });

    const status = await getWebReviewStatus({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
    });

    assert.ok(status);
    assert.equal(status.state, "APPROVED");
    assert.equal(status.review_round, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
