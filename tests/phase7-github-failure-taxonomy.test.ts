import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { verifyGitHubAttestation } from "../src/web-review/github-review-attestation.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, createValidVerdict } from "./helpers/phase7-fixtures.js";

async function withHttpStatus(status: number, expectedCode: string): Promise<void> {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-github-http-")));
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.WCO_GITHUB_TOKEN;
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt);
    process.env.WCO_GITHUB_TOKEN = "test-token";
    globalThis.fetch = (async () => new Response("", { status })) as typeof fetch;

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
      (error: unknown) => error instanceof WebReviewError && error.code === expectedCode
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.WCO_GITHUB_TOKEN;
    else process.env.WCO_GITHUB_TOKEN = previousToken;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test("P7-GH-001: HTTP 401 is an authentication failure", async () => {
  await withHttpStatus(401, "WEB_REVIEW_AUTH_ERROR");
});

test("P7-GH-002: HTTP 429 is a retryable network/service failure class", async () => {
  await withHttpStatus(429, "WEB_REVIEW_NETWORK_ERROR");
});

test("P7-GH-003: HTTP 404 is repository drift, not an authentication failure", async () => {
  await withHttpStatus(404, "WEB_REVIEW_REPOSITORY_DRIFT");
});
