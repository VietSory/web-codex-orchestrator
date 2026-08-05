// Negative and positive tests for ZIP verifier canonical metadata and path safety,
// as well as Web Review Verdict Validator schema 1.1 binding checks.
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
import { validateWebVerdict, type WebReviewVerdict } from "../src/result-bundle/web-verdict-validator.js";
import type { ResultBundleReceipt } from "../src/result-bundle/contracts.js";
import { writeRawZip } from "./helpers/zip-fixture.js";

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
    revision_request_sha256: "0".repeat(64),
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

/** Write a raw ZIP with a single entry using custom name/properties */
async function buildZipWithCustomEntry(outputPath: string, entryName: string, opts?: { mtime?: Date; mode?: number }): Promise<void> {
  if (opts?.mtime || opts?.mode) {
    // If testing timestamp/mode metadata via yazl
    await new Promise<void>((resolve, reject) => {
      const zipfile = new yazl.ZipFile();
      zipfile.addBuffer(Buffer.from("hello"), entryName, {
        mtime: opts?.mtime ?? FIXED_ZIP_TIMESTAMP,
        mode: opts?.mode ?? FIXED_FILE_MODE,
        compress: false,
      });
      zipfile.end();
      const ws = fsSync.createWriteStream(outputPath);
      zipfile.outputStream.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
    });
  } else {
    // Use writeRawZip to bypass yazl's client-side path validation
    await writeRawZip(outputPath, [{
      name: entryName,
      data: Buffer.from("hello"),
      externalFileAttributes: (FIXED_FILE_MODE << 16),
    }]);
  }
}

/** Write a raw ZIP with two entries */
async function buildZipWithTwoEntries(outputPath: string, name1: string, name2: string): Promise<void> {
  await writeRawZip(outputPath, [
    { name: name1, data: Buffer.from("hello"), externalFileAttributes: (FIXED_FILE_MODE << 16) },
    { name: name2, data: Buffer.from("world"), externalFileAttributes: (FIXED_FILE_MODE << 16) },
  ]);
}

// ── 1. ZIP Verifier Canonical Metadata & Path Safety Negative Tests ─────────

test("ZIP-V-001: verifier rejects entry with non-canonical DOS timestamp", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "bad-timestamp.zip");
    await buildZipWithCustomEntry(zipPath, "test.txt", { mtime: new Date() });
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError, `Expected ResultBundleError, got: ${err}`);
        assert.equal((err as ResultBundleError).code, "RESULT_ARCHIVE_VERIFY_FAILED");
        assert.ok((err as ResultBundleError).message.includes("non-canonical timestamp"));
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
    await buildZipWithCustomEntry(zipPath, "test.txt", { mode: 0o100755 });
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError, `Expected ResultBundleError, got: ${err}`);
        assert.equal((err as ResultBundleError).code, "RESULT_ARCHIVE_VERIFY_FAILED");
        assert.ok((err as ResultBundleError).message.includes("non-canonical mode"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-PS-01: verifier rejects path traversal (../escape.txt)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "traversal.zip");
    await buildZipWithCustomEntry(zipPath, "../escape.txt");
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError);
        assert.equal((err as ResultBundleError).code, "RESULT_SOURCE_PATH_UNSAFE");
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-PS-02: verifier rejects absolute path (/tmp/escape.txt)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "absolute.zip");
    await buildZipWithCustomEntry(zipPath, "/tmp/escape.txt");
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError);
        assert.equal((err as ResultBundleError).code, "RESULT_SOURCE_PATH_UNSAFE");
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-PS-03: verifier rejects backslashes (payload\\escape.txt)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "backslash.zip");
    await buildZipWithCustomEntry(zipPath, "payload\\escape.txt");
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError);
        assert.equal((err as ResultBundleError).code, "RESULT_SOURCE_PATH_UNSAFE");
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-PS-04: verifier rejects forbidden prefix (payload/file.txt)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "forbidden.zip");
    await buildZipWithCustomEntry(zipPath, "payload/file.txt");
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError);
        assert.equal((err as ResultBundleError).code, "RESULT_SOURCE_PATH_UNSAFE");
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-PS-05: verifier rejects Windows device name (CON.txt)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "windevice.zip");
    await buildZipWithCustomEntry(zipPath, "CON.txt");
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError);
        assert.equal((err as ResultBundleError).code, "RESULT_SOURCE_PATH_UNSAFE");
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-PS-06: verifier rejects trailing dot/space (file. / file )", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "trailing.zip");
    await buildZipWithCustomEntry(zipPath, "task/file.");
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError);
        assert.equal((err as ResultBundleError).code, "RESULT_SOURCE_PATH_UNSAFE");
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-PS-07: verifier rejects case-fold / NFC collisions", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-verify-"));
  try {
    const tmpRealDir = await fs.realpath(tmpDir);
    const zipPath = path.join(tmpRealDir, "casefold.zip");
    // "TASK/file.txt" < "task/file.txt" in ASCII, so lexical order is preserved
    await buildZipWithTwoEntries(zipPath, "TASK/file.txt", "task/file.txt");
    await assert.rejects(
      () => verifyResultBundleZip(zipPath),
      (err: unknown) => {
        assert.ok(err instanceof ResultBundleError);
        assert.equal((err as ResultBundleError).code, "RESULT_ARCHIVE_PATH_COLLISION");
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
    assert.ok(typeof result.sha256 === "string" && result.sha256.length === 64);
    assert.ok(result.entryCount > 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ZIP-V-004: FIXED_DOS_DATE and FIXED_DOS_TIME constants encode 1980-01-01 00:00:00", () => {
  assert.equal(FIXED_DOS_DATE, 0x0021);
  assert.equal(FIXED_DOS_TIME, 0x0000);
});

test("ZIP-V-005: GPB_ENCRYPTION_BIT is bit 0 of general purpose bit flag", () => {
  assert.equal(GPB_ENCRYPTION_BIT, 0x0001);
});

test("ZIP-V-008: required entry list includes task/README.md and review/web-review-policy.json", () => {
  const entries = new Set(REQUIRED_RESULT_BUNDLE_ENTRIES);
  assert.ok(entries.has("task/README.md"));
  assert.ok(entries.has("task/manifest.json"));
  assert.ok(entries.has("task/checksums.json"));
  assert.ok(entries.has("task/spec-lock.json"));
  assert.ok(entries.has("review/web-review-policy.json"));
});

// ── 2. Web Review Verdict Validator Tests ────────────────────────────────────

function createValidReceipt(): ResultBundleReceipt {
  return {
    result_bundle_version: "1.1",
    run_id: "RUN-1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    state: "READY_FOR_WEB_REVIEW",
    input_digest_sha256: "1".repeat(64),
    execution_receipt_sha256: "2".repeat(64),
    git_publish_receipt_sha256: "3".repeat(64),
    draft_pr_receipt_sha256: "4".repeat(64),
    accepted_bundle_tree_sha256: "5".repeat(64),
    change_set_sha256: "6".repeat(64),
    base_commit: "a".repeat(40),
    published_commit_sha: "b".repeat(40),
    remote_branch_sha: "b".repeat(40),
    pull_request: {
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "open",
      draft: true,
      head_branch: "codex/task",
      head_sha: "c".repeat(40),
      base_branch: "main",
      title_sha256: "7".repeat(64),
    },
    archive_relative_path: "handoff/runs/task/archive.zip",
    archive_sha256: "8".repeat(64),
    archive_size_bytes: 1000,
    entry_count: 10,
    uncompressed_size_bytes: 5000,
    manifest_sha256: "9".repeat(64),
    warnings: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    built_at: "2026-01-01T00:00:00.000Z",
    verified_at: "2026-01-01T00:00:00.000Z",
    ready_at: "2026-01-01T00:00:00.000Z",
    spec_set_sha256: "e".repeat(64),
    review_contract_sha256: "f".repeat(64),
    review_policy_sha256: "0".repeat(64),
    verdict_schema_sha256: "1".repeat(64),
    revision_request_schema_sha256: "2".repeat(64),
  };
}

function createValidVerdict(receipt: ResultBundleReceipt): WebReviewVerdict {
  return {
    schema_version: "1.1",
    verdict: "APPROVE",
    review_mode: "INITIAL",
    review_round: 1,
    run_id: receipt.run_id,
    spec_set_sha256: receipt.spec_set_sha256!,
    result_bundle_sha256: receipt.archive_sha256!,
    manifest_sha256: receipt.manifest_sha256!,
    reviewed_entry_set_sha256: receipt.accepted_bundle_tree_sha256,
    published_commit_sha: receipt.published_commit_sha,
    pull_request_number: receipt.pull_request.number,
    observed_head_sha: receipt.pull_request.head_sha,
    review_contract_version: "1.1",
    review_policy_version: "1.0",
    previous_result_bundle_sha256: null,
    previous_verdict_sha256: null,
    revision_request_sha256: null,
    previous_published_commit_sha: null,
    comprehensive_review_complete: true,
    criterion_results: [
      {
        criterion_id: "AC-1",
        required: true,
        status: "PASS",
        evidence_refs: ["evidence/verification.json"],
        notes: "All commands passed",
      },
    ],
    blocking_findings: [],
    non_blocking_backlog: [],
    summary: "Comprehensive review completed and approved.",
  };
}

test("WV-001: valid web review verdict passes validateWebVerdict", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  const acceptance = { criteria: [{ id: "AC-1" }] };
  const bundleEntries = new Set(["evidence/verification.json", "manifest.json"]);

  assert.doesNotThrow(() => validateWebVerdict(verdict, acceptance, receipt, bundleEntries));
});

test("WV-002: validateWebVerdict rejects run_id mismatch", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.run_id = "RUN-MISMATCH:0000000000000000000000000000000000000000000000000000000000000000";

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("run_id mismatch"));
      return true;
    }
  );
});

test("WV-003: validateWebVerdict rejects result_bundle_sha256 mismatch", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.result_bundle_sha256 = "0".repeat(64);

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("result_bundle_sha256 mismatch"));
      return true;
    }
  );
});

test("WV-004: validateWebVerdict rejects manifest_sha256 mismatch", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.manifest_sha256 = "0".repeat(64);

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("manifest_sha256 mismatch"));
      return true;
    }
  );
});

test("WV-005: validateWebVerdict rejects spec_set_sha256 mismatch", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.spec_set_sha256 = "0".repeat(64);

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("spec_set_sha256 mismatch"));
      return true;
    }
  );
});

test("WV-006: validateWebVerdict rejects pull_request_number mismatch", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.pull_request_number = 999;

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("pull_request_number mismatch"));
      return true;
    }
  );
});

test("WV-007: validateWebVerdict rejects published_commit_sha mismatch", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.published_commit_sha = "f".repeat(40);

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("published_commit_sha mismatch"));
      return true;
    }
  );
});

test("WV-008: validateWebVerdict rejects observed_head_sha mismatch", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.observed_head_sha = "f".repeat(40);

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("observed_head_sha mismatch"));
      return true;
    }
  );
});

test("WV-009: validateWebVerdict rejects reviewed_entry_set_sha256 mismatch", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.reviewed_entry_set_sha256 = "0".repeat(64);

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("reviewed_entry_set_sha256 mismatch"));
      return true;
    }
  );
});

test("WV-010: validateWebVerdict rejects missing evidence reference in bundle entries", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.criterion_results[0]!.evidence_refs = ["evidence/nonexistent.json"];

  const bundleEntries = new Set(["evidence/verification.json", "manifest.json"]);

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt, bundleEntries),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("Evidence reference not found"));
      return true;
    }
  );
});

test("WV-011: validateWebVerdict rejects missing artifact path in blocking finding", () => {
  const receipt = createValidReceipt();
  const verdict = createValidVerdict(receipt);
  verdict.verdict = "REVISE";
  verdict.criterion_results[0]!.status = "FAIL";
  verdict.blocking_findings = [
    {
      finding_id: "WEB-FIND-001",
      classification: "SPEC_VIOLATION",
      finding_origin: "INITIAL_DISCOVERY",
      previous_finding_id: null,
      locked_reference_ids: ["AC-1"],
      artifact_paths: ["repository/source/missing-file.ts"],
      line_or_json_pointer: "line 10",
      expected_behavior: "expected",
      observed_behavior: "observed",
      evidence: "evidence",
      minimal_required_fix: "fix",
      revision_changed_paths: [],
    },
  ];

  const bundleEntries = new Set(["evidence/verification.json", "manifest.json"]);

  assert.throws(
    () => validateWebVerdict(verdict, { criteria: [{ id: "AC-1" }] }, receipt, bundleEntries),
    (err: unknown) => {
      assert.ok(err instanceof ResultBundleError);
      assert.equal((err as ResultBundleError).code, "RESULT_WEB_VERDICT_INVALID");
      assert.ok((err as ResultBundleError).message.includes("Artifact path in finding not found"));
      return true;
    }
  );
});
