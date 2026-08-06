import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { submitWebVerdict, getWebReviewStatus } from "../src/web-review/web-review-service.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, createValidVerdict, TEST_RUN_ID } from "./helpers/phase7-fixtures.js";

test("PERSIST-001: exact retry of submitWebVerdict is idempotent", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-pers-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt);
    const verdictPath = path.join(tmpDir, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2));

    const receipt1 = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath: "dummy.json",
      verdictPath,
    });

    assert.equal(receipt1.state, "APPROVED");

    // Exact retry
    const receipt2 = await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath: "dummy.json",
      verdictPath,
    });

    assert.equal(receipt2.state, "APPROVED");
    assert.equal(receipt2.verdict_sha256, receipt1.verdict_sha256);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PERSIST-002: conflicting verdict submitted to a sealed round is rejected", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-pers-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict1 = createValidVerdict(fixture.receipt, { summary: "First summary" });
    const verdictPath1 = path.join(tmpDir, "verdict1.json");
    await fs.writeFile(verdictPath1, JSON.stringify(verdict1, null, 2));

    await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath: "dummy.json",
      verdictPath: verdictPath1,
    });

    // Conflicting verdict with different content
    const verdict2 = createValidVerdict(fixture.receipt, { summary: "Different summary" });
    const verdictPath2 = path.join(tmpDir, "verdict2.json");
    await fs.writeFile(verdictPath2, JSON.stringify(verdict2, null, 2));

    await assert.rejects(
      () => submitWebVerdict({
        runId: fixture.receipt.run_id,
        stateDirectory: fixture.stateDirectory,
        configPath: "dummy.json",
        verdictPath: verdictPath2,
      }),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_ALREADY_SEALED");
        assert.ok((err as WebReviewError).message.includes("already sealed with a different verdict"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PERSIST-003: getWebReviewStatus is read-only and does not perform validation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-pers-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const verdict = createValidVerdict(fixture.receipt);
    const verdictPath = path.join(tmpDir, "verdict.json");
    await fs.writeFile(verdictPath, JSON.stringify(verdict, null, 2));

    await submitWebVerdict({
      runId: fixture.receipt.run_id,
      stateDirectory: fixture.stateDirectory,
      configPath: "dummy.json",
      verdictPath,
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
