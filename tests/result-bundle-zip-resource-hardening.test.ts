import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonBuffer } from "../src/result-bundle/canonical-json.js";
import { ResultBundleError } from "../src/result-bundle/contracts.js";
import { buildDeterministicZip } from "../src/result-bundle/deterministic-zip.js";
import { REQUIRED_RESULT_BUNDLE_ENTRIES } from "../src/result-bundle/result-bundle-paths.js";
import { verifyResultBundleZip } from "../src/result-bundle/zip-verifier.js";

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

async function buildValidArchive(root: string): Promise<string> {
  const entries: Array<{ path: string; content: Buffer }> = [];
  for (const required of REQUIRED_RESULT_BUNDLE_ENTRIES) {
    if (required === "manifest.json") continue;
    entries.push({ path: required, content: Buffer.from(`fixture:${required}`, "utf8") });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifestEntries = entries.map((entry) => ({
    path: entry.path,
    sha256: sha256(entry.content),
    size_bytes: entry.content.byteLength,
  }));
  const reviewedEntrySetSha256 = sha256(canonicalJsonBuffer(manifestEntries));
  const manifest = canonicalJsonBuffer({
    schema_version: "1.1",
    kind: "wco-result-bundle",
    run_id: `ZIP-HARD:${"a".repeat(64)}`,
    archive_filename: "resource-hardening.zip",
    published_commit_sha: "1".repeat(40),
    base_commit: "2".repeat(40),
    change_set_sha256: "3".repeat(64),
    pull_request_number: 1,
    task_id: "ZIP-HARD",
    created_at: "2026-08-09T00:00:00.000Z",
    spec_set_sha256: "4".repeat(64),
    review_contract_sha256: "5".repeat(64),
    review_policy_sha256: "6".repeat(64),
    verdict_schema_sha256: "7".repeat(64),
    revision_request_schema_sha256: "8".repeat(64),
    reviewed_entry_set_sha256: reviewedEntrySetSha256,
    entries: manifestEntries,
  });
  const allEntries = [...entries, { path: "manifest.json", content: manifest }]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return (await buildDeterministicZip(allEntries, root, "resource-hardening.zip", {
    maximumEntries: 512,
    maximumArchiveBytes: 32 * 1024 * 1024,
    maximumTotalUncompressedBytes: 64 * 1024 * 1024,
  })).archivePath;
}

test("ZIP-HARD-001 archive symlink is rejected instead of followed", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation may require developer privileges; Linux CI covers the no-follow boundary.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-hard-link-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const archive = await buildValidArchive(root);
  const link = path.join(root, "archive-link.zip");
  await fs.symlink(archive, link);
  await assert.rejects(
    verifyResultBundleZip(link),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_ARCHIVE_VERIFY_FAILED",
  );
});

test("ZIP-HARD-002 archive byte cap is enforced before ZIP parsing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-hard-archive-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const archive = await buildValidArchive(root);
  await assert.rejects(
    verifyResultBundleZip(archive, { maximum_archive_bytes: 1 }),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_ARCHIVE_SIZE_LIMIT",
  );
});

test("ZIP-HARD-003 declared entry cap is enforced before entry decompression", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-hard-entry-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const archive = await buildValidArchive(root);
  await assert.rejects(
    verifyResultBundleZip(archive, { maximum_entry_bytes: 1 }),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_ARCHIVE_SIZE_LIMIT",
  );
});

test("ZIP-HARD-004 declared entry-count cap is enforced before traversal", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-hard-count-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const archive = await buildValidArchive(root);
  await assert.rejects(
    verifyResultBundleZip(archive, { maximum_entries: 1 }),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_ARCHIVE_ENTRY_LIMIT",
  );
});

test("ZIP-HARD-005 early rejection does not let yauzl close the caller-owned fd", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-zip-hard-fd-owner-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const archive = await buildValidArchive(root);
  const originalClose = nodeFs.close;
  let libraryCloseCalls = 0;
  nodeFs.close = ((fd, callback) => {
    libraryCloseCalls += 1;
    callback?.(null);
  }) as typeof nodeFs.close;
  try {
    await assert.rejects(
      verifyResultBundleZip(archive, { maximum_entries: 1 }),
      (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_ARCHIVE_ENTRY_LIMIT",
    );
  } finally {
    nodeFs.close = originalClose;
  }
  assert.equal(libraryCloseCalls, 0, "yauzl must not close the verifier-owned archive descriptor");
});
