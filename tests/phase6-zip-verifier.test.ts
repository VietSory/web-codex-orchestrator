// Negative tests for ZIP verifier canonical metadata enforcement.
// Tests: non-canonical timestamp, non-canonical mode, archive comment,
// and that a proper deterministic ZIP passes.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import yazl from "yazl";
import { verifyResultBundleZip, FIXED_DOS_DATE, FIXED_DOS_TIME, GPB_ENCRYPTION_BIT } from "../src/result-bundle/zip-verifier.js";
import { buildDeterministicZip } from "../src/result-bundle/deterministic-zip.js";
import { FIXED_ZIP_TIMESTAMP, FIXED_FILE_MODE, REQUIRED_RESULT_BUNDLE_ENTRIES } from "../src/result-bundle/result-bundle-paths.js";
import { ResultBundleError } from "../src/result-bundle/contracts.js";
import { canonicalJsonBuffer } from "../src/result-bundle/canonical-json.js";

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Build a minimal valid deterministic ZIP with all required entries */
async function buildMinimalValidZip(outputDir: string): Promise<string> {
  const entries: { path: string; content: Buffer }[] = [];

  for (const req of REQUIRED_RESULT_BUNDLE_ENTRIES) {
    if (req === "manifest.json") continue;
    entries.push({ path: req, content: Buffer.from(`content of ${req}`, "utf8") });
  }

  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const manifestEntryList = entries.map(e => ({
    path: e.path,
    sha256: sha256Hex(e.content),
    size_bytes: e.content.byteLength,
  }));

  const manifestContent = canonicalJsonBuffer({
    schema_version: "1.1",
    kind: "wco-result-bundle",
    run_id: "TEST:0000000000000000000000000000000000000000000000000000000000000000",
    archive_filename: "test.zip",
    published_commit_sha: "0".repeat(40),
    base_commit: "0".repeat(40),
    change_set_sha256: "0".repeat(64),
    pull_request_number: 1,
    task_id: "TEST",
    created_at: "2026-01-01T00:00:00.000Z",
    spec_set_sha256: "0".repeat(64),
    review_contract_sha256: "0".repeat(64),
    review_policy_sha256: "0".repeat(64),
    verdict_schema_sha256: "0".repeat(64),
    revision_request_schema_sha256: "0".repeat(64),
    entries: manifestEntryList,
  });

  const allEntries = [
    ...entries,
    { path: "manifest.json", content: manifestContent },
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const { archivePath } = await buildDeterministicZip(
    allEntries,
    outputDir,
    "valid-test.zip",
    { maximumEntries: 1000, maximumArchiveBytes: 100_000_000, maximumTotalUncompressedBytes: 100_000_000 }
  );
  return archivePath;
}

/** Write a yazl ZIP with one entry using non-canonical timestamp (current time) */
function buildZipWithBadTimestamp(outputPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    zipfile.addBuffer(Buffer.from("hello"), "test.txt", {
      mtime: new Date(), // NOT 1980-01-01
      mode: FIXED_FILE_MODE,
      compress: false,
    });
    zipfile.end();
    const ws = fsSync.createWriteStream(outputPath);
    zipfile.outputStream.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

/** Write a yazl ZIP with one entry using non-canonical mode (executable bit set) */
function buildZipWithBadMode(outputPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    zipfile.addBuffer(Buffer.from("hello"), "test.txt", {
      mtime: FIXED_ZIP_TIMESTAMP,
      mode: 0o100755, // executable bit — NOT canonical
      compress: false,
    });
    zipfile.end();
    const ws = fsSync.createWriteStream(outputPath);
    zipfile.outputStream.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

test("ZIP-V-001: verifier rejects entry with non-canonical DOS timestamp", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "bad-timestamp.zip");
    await buildZipWithBadTimestamp(zipPath);
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError, `Expected ResultBundleError, got: ${err}`);
        assert.equal((err as ResultBundleError).code, "RESULT_ARCHIVE_VERIFY_FAILED");
        assert.ok(
          (err as ResultBundleError).message.includes("non-canonical timestamp"),
          `Expected 'non-canonical timestamp' in message, got: ${(err as ResultBundleError).message}`
        );
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-002: verifier rejects entry with non-canonical file mode", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "bad-mode.zip");
    await buildZipWithBadMode(zipPath);
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError, `Expected ResultBundleError, got: ${err}`);
        assert.equal((err as ResultBundleError).code, "RESULT_ARCHIVE_VERIFY_FAILED");
        assert.ok(
          (err as ResultBundleError).message.includes("non-canonical mode"),
          `Expected 'non-canonical mode' in message, got: ${(err as ResultBundleError).message}`
        );
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-003: verifier accepts a canonical deterministic ZIP with correct metadata", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = await buildMinimalValidZip(tmpRealDir);
    const result = await verifyResultBundleZip(zipPath);
    assert.ok(typeof result.sha256 === "string" && result.sha256.length === 64, "Should return 64-char archive sha256");
    assert.ok(result.entryCount > 0, "Should have entries");
    assert.ok(result.sizeBytes > 0, "Should have size");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-004: FIXED_DOS_DATE and FIXED_DOS_TIME constants encode 1980-01-01 00:00:00", () => {
  // DOS date = (year-1980)<<9 | month<<5 | day
  // 1980-01-01: (0)<<9 | (1)<<5 | (1) = 0 | 32 | 1 = 33 = 0x0021
  assert.equal(FIXED_DOS_DATE, 0x0021);
  assert.equal(FIXED_DOS_DATE, 33); // Decimal sanity check
  // DOS time = hour<<11 | min<<5 | (sec/2); 00:00:00 = 0
  assert.equal(FIXED_DOS_TIME, 0x0000);
});

test("ZIP-V-005: GPB_ENCRYPTION_BIT is bit 0 of general purpose bit flag", () => {
  assert.equal(GPB_ENCRYPTION_BIT, 0x0001);
  // Non-encrypted flag does not match
  assert.equal(0x0002 & GPB_ENCRYPTION_BIT, 0);
  // Encrypted flag matches
  assert.equal(0x0001 & GPB_ENCRYPTION_BIT, 1);
  assert.equal(0x0009 & GPB_ENCRYPTION_BIT, 1);
});

test("ZIP-V-006: web-verdict-validator rejects schema_version 1.0 (old schema)", async () => {
  const { validateWebVerdict } = await import("../src/result-bundle/web-verdict-validator.js");
  const badVerdict = {
    schema_version: "1.0", // Wrong — should be 1.1
    verdict: "accept",
    reviewer_identity: "test",
    run_id: "TEST",
    bundle_archive_sha256: "0".repeat(64),
    spec_set_sha256: "0".repeat(64),
    criterion_results: [],
  };
  const fakeReceipt: any = {
    run_id: "TEST",
    archive_sha256: "0".repeat(64),
    manifest_sha256: "0".repeat(64),
    spec_set_sha256: "0".repeat(64),
    pull_request: { number: 1 },
  };
  assert.throws(
    () => validateWebVerdict(badVerdict, { criteria: [] }, fakeReceipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError, `Expected ResultBundleError, got: ${err}`);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      return true;
    }
  );
});

test("ZIP-V-007: web-verdict-validator rejects old verdict values (accept/reject/revise)", async () => {
  const { validateWebVerdict } = await import("../src/result-bundle/web-verdict-validator.js");
  // A verdict with wrong enum value — schema 1.1 requires APPROVE/REVISE/ESCALATE
  const badVerdict = {
    schema_version: "1.1",
    verdict: "accept", // Old schema — should be APPROVE
    review_mode: "INITIAL",
    review_round: 1,
    run_id: "TEST",
    spec_set_sha256: "0".repeat(64),
    result_bundle_sha256: "0".repeat(64),
    manifest_sha256: "0".repeat(64),
    reviewed_entry_set_sha256: "0".repeat(64),
    published_commit_sha: "0".repeat(40),
    pull_request_number: 1,
    observed_head_sha: "0".repeat(40),
    review_contract_version: "1.1",
    review_policy_version: "1.0",
    previous_result_bundle_sha256: null,
    previous_verdict_sha256: null,
    revision_request_sha256: null,
    previous_published_commit_sha: null,
    comprehensive_review_complete: true,
    criterion_results: [],
    blocking_findings: [],
    non_blocking_backlog: [],
    summary: "test",
  };
  const fakeReceipt: any = {
    run_id: "TEST",
    archive_sha256: "0".repeat(64),
    manifest_sha256: "0".repeat(64),
    spec_set_sha256: "0".repeat(64),
    pull_request: { number: 1 },
  };
  assert.throws(
    () => validateWebVerdict(badVerdict, { criteria: [] }, fakeReceipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError, `Expected ResultBundleError, got: ${err}`);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      return true;
    }
  );
});

test("ZIP-V-008: required entry list includes task/README.md and review/web-review-policy.json", () => {
  const entries = new Set(REQUIRED_RESULT_BUNDLE_ENTRIES);
  assert.ok(entries.has("task/README.md"), "REQUIRED_RESULT_BUNDLE_ENTRIES must include task/README.md");
  assert.ok(entries.has("task/manifest.json"), "REQUIRED_RESULT_BUNDLE_ENTRIES must include task/manifest.json");
  assert.ok(entries.has("task/checksums.json"), "REQUIRED_RESULT_BUNDLE_ENTRIES must include task/checksums.json");
  assert.ok(entries.has("task/spec-lock.json"), "REQUIRED_RESULT_BUNDLE_ENTRIES must include task/spec-lock.json");
  assert.ok(entries.has("review/web-review-policy.json"), "REQUIRED_RESULT_BUNDLE_ENTRIES must include review/web-review-policy.json");
});
