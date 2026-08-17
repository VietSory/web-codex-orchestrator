import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReadCoverageStore, type ReadCoverageReceipt } from "../src/web-bridge/read-coverage-store.js";

const EMPTY_GIT_BLOB_OID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const EMPTY_CONTENT_SHA256 = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");

function receipt(overrides: Partial<ReadCoverageReceipt> = {}): ReadCoverageReceipt {
  return {
    schema_version: "1.0",
    job_id: "job-empty-binding",
    request_id: "req-empty-binding",
    base_commit: "a".repeat(40),
    path: "empty.txt",
    blob_sha: EMPTY_GIT_BLOB_OID,
    content_sha256: EMPTY_CONTENT_SHA256,
    start_byte: 0,
    end_byte_exclusive: 0,
    total_bytes: 0,
    observed_at: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

test("zero-byte read receipt is accepted only with canonical empty Git/content digests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-empty-receipt-binding-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const canonicalStore = new ReadCoverageStore(path.join(root, "canonical"));
  await canonicalStore.append(receipt());
  assert.deepEqual(await canonicalStore.list("job-empty-binding"), [receipt()]);

  const forgedBlobStore = new ReadCoverageStore(path.join(root, "forged-blob"));
  await assert.rejects(
    forgedBlobStore.append(receipt({ blob_sha: "b".repeat(40) })),
    /canonical empty Git blob and content digest/i,
  );

  const forgedContentStore = new ReadCoverageStore(path.join(root, "forged-content"));
  await assert.rejects(
    forgedContentStore.append(receipt({ content_sha256: "c".repeat(64) })),
    /canonical empty Git blob and content digest/i,
  );
});
