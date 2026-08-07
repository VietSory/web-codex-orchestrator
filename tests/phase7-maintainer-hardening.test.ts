import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { acquireReviewLock } from "../src/web-review/web-review-lock.js";
import { prepareReviewRoundDirectory, resolveReviewRoundPaths } from "../src/web-review/web-review-paths.js";
import { writeCanonicalArtifact } from "../src/web-review/web-review-store.js";
import { verifyGitHubAttestation } from "../src/web-review/github-review-attestation.js";
import { submitWebVerdict } from "../src/web-review/web-review-service.js";
import { WebReviewError } from "../src/web-review/contracts.js";
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
      };
    },
  };
}

async function createConfig(stateDir: string): Promise<string> {
  const configPath = path.join(stateDir, "phase7-maintainer-config.json");
  await fs.writeFile(configPath, JSON.stringify({
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
  }));
  return fs.realpath(configPath);
}

test("P7-MAINT-001: stale lock is never auto-deleted or stolen", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-maint-lock-")));
  try {
    const lockPath = path.join(tmpDir, "web-review.lock");
    const stale = JSON.stringify({
      pid: 2_147_483_647,
      nonce: "stale-owner",
      acquired_at: "2026-01-01T00:00:00.000Z",
    }) + "\n";
    await fs.writeFile(lockPath, stale);

    await assert.rejects(
      () => acquireReviewLock(lockPath, 75),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_LOCK_FAILED" && error.message.includes("never auto-steals")
    );
    assert.equal(await fs.readFile(lockPath, "utf8"), stale);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-MAINT-002: review lifecycle symlink ancestor cannot redirect writes", { skip: process.platform === "win32" }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-maint-path-")));
  try {
    const stateDir = path.join(root, "state");
    const outside = path.join(root, "outside");
    await fs.mkdir(stateDir);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(stateDir, "handoff"));

    const runId = `TASK:${"1".repeat(64)}`;
    const paths = resolveReviewRoundPaths(stateDir, runId, 1);
    await assert.rejects(
      () => prepareReviewRoundDirectory(stateDir, paths.roundDir),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_ATTEMPTED_PATH_ESCAPE"
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("P7-MAINT-003: canonical artifact compare never follows a symlink target", { skip: process.platform === "win32" }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-maint-artifact-")));
  try {
    const roundDir = path.join(root, "round");
    await fs.mkdir(roundDir);
    const outside = path.join(root, "outside.json");
    const artifact = path.join(roundDir, "decision-event.json");
    await fs.writeFile(outside, "outside\n");
    await fs.symlink(outside, artifact);

    await assert.rejects(
      () => writeCanonicalArtifact(artifact, Buffer.from("replacement\n")),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_ALREADY_SEALED"
    );
    assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("P7-MAINT-004: Phase 6 receipt must still bind a Draft PR", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-maint-receipt-draft-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const receipt = {
      ...fixture.receipt,
      pull_request: { ...fixture.receipt.pull_request, draft: false },
    };
    const verdict = createValidVerdict(receipt);
    await assert.rejects(
      () => verifyGitHubAttestation({ receipt, config: {} as never, verdict, githubClient: githubClient() }),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_REPOSITORY_DRIFT" && error.message.includes("Draft")
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-MAINT-005: fresh GitHub attestation rejects a PR marked Ready", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-maint-live-draft-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt);
    await assert.rejects(
      () => verifyGitHubAttestation({
        receipt: fixture.receipt,
        config: {} as never,
        verdict,
        githubClient: githubClient({ draft: false }),
      }),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_REPOSITORY_DRIFT" && error.message.includes("Draft")
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-MAINT-006: idempotent terminal retry performs fresh GitHub attestation", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-maint-retry-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createConfig(fixture.stateDirectory);
    const verdict = createValidVerdict(fixture.receipt);
    const verdictPath = path.join(tmpDir, "web-review-verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    const approved = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
      githubClient: githubClient(),
    });
    assert.equal(approved.state, "APPROVED");

    await assert.rejects(
      () => submitWebVerdict({
        runId: fixture.receipt.run_id,
        stateDirectory: fixture.stateDirectory,
        configPath,
        verdictPath,
        githubClient: githubClient({ draft: false }),
      }),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_REPOSITORY_DRIFT"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-MAINT-007: production GitHub body is stream-bounded without Content-Length", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-maint-stream-")));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.WCO_GITHUB_TOKEN;
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt);
    process.env.WCO_GITHUB_TOKEN = "test-token";

    let pulls = 0;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(300_000));
          if (pulls >= 10) controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    await assert.rejects(
      () => verifyGitHubAttestation({
        receipt: fixture.receipt,
        config: {
          github_pull_request: {
            provider: "github.com",
            authentication: { mode: "https_token", token_environment_key: "WCO_GITHUB_TOKEN" },
          },
        } as never,
        verdict,
      }),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_REPOSITORY_DRIFT" && error.message.includes("exceeds")
    );
    assert.ok(pulls < 10, `stream should be cancelled at the cap, pulled ${pulls} chunks`);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.WCO_GITHUB_TOKEN;
    else process.env.WCO_GITHUB_TOKEN = previousToken;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
