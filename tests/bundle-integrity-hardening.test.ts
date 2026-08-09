import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { snapshotBundle } from "../src/execution/bundle-integrity.js";
import { ExecutionError } from "../src/execution/errors.js";
import { DEFAULT_ARCHIVE_LIMITS } from "../src/intake/constants.js";

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("BUNDLE-INTEGRITY-HARD-001 bounded snapshot preserves the existing relative-file/hash contract", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-bundle-integrity-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "a.txt"), "alpha");
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested", "b.txt"), "beta");

  const expectedEntries = [
    { relative: "a.txt", hash: sha256("alpha") },
    { relative: "nested/b.txt", hash: sha256("beta") },
  ];
  const snapshot = await snapshotBundle(root);

  assert.deepEqual(snapshot.files, expectedEntries.map((entry) => `${entry.relative}:${entry.hash}`));
  assert.equal(snapshot.sha256, sha256(JSON.stringify(expectedEntries)));
});

test("BUNDLE-INTEGRITY-HARD-002 post-intake oversized files fail before whole-file allocation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-bundle-integrity-size-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const oversized = path.join(root, "oversized.bin");
  await fs.writeFile(oversized, "");
  await fs.truncate(oversized, DEFAULT_ARCHIVE_LIMITS.maximumEntryUncompressedBytes + 1);

  await assert.rejects(
    () => snapshotBundle(root),
    (error: unknown) => error instanceof ExecutionError && error.code === "BUNDLE_MUTATED" && /trusted limits/.test(error.message),
  );
});
