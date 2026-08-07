import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  MAX_RECEIPT_ERRORS,
  MAX_REVIEW_STATE_FILE_BYTES,
  assertWebReviewReceipt,
  readCanonicalArtifact,
  readWebReviewReceipt,
  writeWebReviewReceipt,
} from "../src/web-review/web-review-store.js";
import { resolveReviewRoundPaths } from "../src/web-review/web-review-paths.js";
import { submitWebVerdict } from "../src/web-review/web-review-service.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, createValidVerdict } from "./helpers/phase7-fixtures.js";

async function createConfig(stateDir: string): Promise<string> {
  const configPath = path.join(stateDir, "state-bounds-config.json");
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

test("P7-STATE-001: oversized persisted canonical artifact is rejected before use", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-state-cap-")));
  try {
    const artifact = path.join(tmpDir, "oversized.json");
    await fs.writeFile(artifact, Buffer.alloc(MAX_REVIEW_STATE_FILE_BYTES + 1));
    await assert.rejects(
      () => readCanonicalArtifact(artifact),
      (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_OPERATIONAL_ERROR" && error.message.includes("exceeds")
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P7-STATE-002: tampered receipt cannot contain unbounded error history", () => {
  const errors = Array.from({ length: MAX_RECEIPT_ERRORS + 1 }, (_, index) => ({
    code: `E${index}`,
    message: "bounded",
  }));
  const receipt: any = {
    phase_version: "1.1",
    run_id: `TASK:${"1".repeat(64)}`,
    review_mode: "INITIAL",
    review_round: 1,
    state: "BLOCKED",
    phase6_receipt_sha256: "1".repeat(64),
    result_bundle_sha256: "2".repeat(64),
    manifest_sha256: "3".repeat(64),
    reviewed_entry_set_sha256: "4".repeat(64),
    spec_set_sha256: "5".repeat(64),
    verdict_sha256: "6".repeat(64),
    published_commit_sha: "a".repeat(40),
    pull_request_number: 1,
    observed_head_sha: "a".repeat(40),
    fresh_attested_head_sha: null,
    fresh_attested_base_branch: null,
    previous_result_bundle_sha256: null,
    previous_verdict_sha256: null,
    previous_published_commit_sha: null,
    previous_pr_head_sha: null,
    revision_request_sha256: null,
    decision_event_sha256: null,
    action: null,
    artifact_paths: { verdict: null, receipt: "receipt.json", decision_event: null, revision_request: null, lock: "lock" },
    warnings: [],
    errors,
    created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z",
    validated_at: null,
    completed_at: null,
  };
  assert.throws(
    () => assertWebReviewReceipt(receipt),
    (error: unknown) => error instanceof WebReviewError && error.code === "WEB_REVIEW_RECEIPT_INVALID" && error.message.includes("errors")
  );
});

test("P7-STATE-003: repeated blocked retry keeps only bounded receipt errors", async () => {
  const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "p7-state-retry-")));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const configPath = await createConfig(fixture.stateDirectory);
    const verdict = createValidVerdict(fixture.receipt, { run_id: `OTHER:${"9".repeat(64)}` });
    const verdictPath = path.join(tmpDir, "invalid-verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict));

    await assert.rejects(() => submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
    }));

    const paths = resolveReviewRoundPaths(fixture.stateDirectory, fixture.receipt.run_id, 1);
    const initial = await readWebReviewReceipt(paths.receiptPath);
    assert.ok(initial);
    initial.errors = Array.from({ length: MAX_RECEIPT_ERRORS }, (_, index) => ({
      code: `PREVIOUS_${index}`,
      message: "previous bounded failure",
    }));
    await writeWebReviewReceipt(paths.receiptPath, initial);

    await assert.rejects(() => submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath,
      verdictPath,
    }));

    const after = await readWebReviewReceipt(paths.receiptPath);
    assert.ok(after);
    assert.equal(after.errors.length, MAX_RECEIPT_ERRORS);
    assert.ok(after.errors.at(-1)?.code.startsWith("WEB_REVIEW_"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
