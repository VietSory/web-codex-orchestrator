import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadAndVerifyResultBundle } from "../src/web-review/result-bundle-review-reader.js";
import { WebReviewError } from "../src/web-review/contracts.js";
import { createPhase6BundleFixture, TEST_RUN_ID, TEST_ARCHIVE_SHA } from "./helpers/phase7-fixtures.js";

test("BUNDLE-001: loadAndVerifyResultBundle loads valid Phase 6 bundle", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bundle-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const loaded = await loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id);

    assert.equal(loaded.receipt.state, "READY_FOR_WEB_REVIEW");
    assert.equal(loaded.receipt.archive_sha256, fixture.receipt.archive_sha256);
    assert.ok(loaded.bundleEntries.has("manifest.json"));
    assert.ok(loaded.bundleEntries.has("task/acceptance.json"));
    assert.ok(loaded.acceptanceData);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BUNDLE-002: loadAndVerifyResultBundle rejects missing receipt", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bundle-"));
  try {
    await assert.rejects(
      () => loadAndVerifyResultBundle(tmpDir, TEST_RUN_ID),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_RESULT_BUNDLE_INVALID");
        assert.ok((err as WebReviewError).message.includes("receipt not found"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BUNDLE-003: loadAndVerifyResultBundle rejects receipt not in READY_FOR_WEB_REVIEW state", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bundle-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir, { state: "VERIFIED" });

    await assert.rejects(
      () => loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_RESULT_BUNDLE_INVALID");
        assert.ok((err as WebReviewError).message.includes("expected 'READY_FOR_WEB_REVIEW'"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BUNDLE-004: loadAndVerifyResultBundle rejects manifest sha mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bundle-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir, { manifest_sha256: "0".repeat(64) });

    await assert.rejects(
      () => loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_RESULT_BUNDLE_INVALID");
        assert.ok((err as WebReviewError).message.includes("Manifest SHA mismatch"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BUNDLE-005: loadAndVerifyResultBundle rejects reviewed_entry_set_sha256 mismatch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bundle-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir, { reviewed_entry_set_sha256: "0".repeat(64) });

    await assert.rejects(
      () => loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_RESULT_BUNDLE_INVALID");
        assert.ok((err as WebReviewError).message.includes("reviewed_entry_set_sha256"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("BUNDLE-006: loadAndVerifyResultBundle rejects symlink archive file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-bundle-"));
  try {
    const fixture = await createPhase6BundleFixture(tmpDir);
    const realArchive = fixture.archivePath;
    const symlinkArchive = `${realArchive}.symlink.zip`;
    await fs.rename(realArchive, symlinkArchive);
    await fs.symlink(symlinkArchive, realArchive);

    await assert.rejects(
      () => loadAndVerifyResultBundle(fixture.stateDirectory, fixture.receipt.run_id),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_RESULT_BUNDLE_INVALID");
        assert.ok((err as WebReviewError).message.includes("symbolic link"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
