import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from "../src/intake/constants.js";
import { verifyBundleChecksums } from "../src/intake/checksum-verifier.js";
import { IntakeError } from "../src/intake/errors.js";
import { attestAcceptedBundleAuthority } from "../src/revision/revision-authority.js";
import { RevisionError } from "../src/revision/contracts.js";

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeChecksummedBundle(root: string, files: Record<string, Buffer | string>): Promise<void> {
  const checksums: Record<string, string> = {};
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
    await fs.writeFile(absolute, bytes);
    checksums[relative] = sha256(bytes);
  }
  await fs.writeFile(path.join(root, "checksums.json"), JSON.stringify({ algorithm: "sha256", files: checksums }));
}

function limits(overrides: Partial<ArchiveLimits>): ArchiveLimits {
  return { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
}

test("CHECKSUM-BOUND-001 trusted revalidation rejects an oversized file before hashing it without a cap", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-checksum-entry-bound-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await writeChecksummedBundle(root, { "large.txt": Buffer.alloc(2048, 0x61) });

  await assert.rejects(
    () => verifyBundleChecksums(root, limits({ maximumEntryUncompressedBytes: 1024 })),
    (error: unknown) => error instanceof IntakeError && error.code === "CHECKSUMS_INVALID" && /exceeds 1024 bytes/.test(error.message),
  );
});

test("CHECKSUM-BOUND-002 trusted revalidation bounds recursive entry count", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-checksum-entry-count-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await writeChecksummedBundle(root, { "a.txt": "a", "nested/b.txt": "b" });

  await assert.rejects(
    () => verifyBundleChecksums(root, limits({ maximumEntries: 2 })),
    (error: unknown) => error instanceof IntakeError && error.code === "CHECKSUMS_INVALID" && /exceeds 2 entries/.test(error.message),
  );
});

test("CHECKSUM-BOUND-003 trusted revalidation bounds aggregate extracted bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-checksum-total-bound-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await writeChecksummedBundle(root, {
    "a.bin": Buffer.alloc(600, 0x61),
    "b.bin": Buffer.alloc(600, 0x62),
  });

  await assert.rejects(
    () => verifyBundleChecksums(root, limits({ maximumEntryUncompressedBytes: 1024, maximumTotalUncompressedBytes: 1024 })),
    (error: unknown) => error instanceof IntakeError && error.code === "CHECKSUMS_INVALID" && /exceeds 1024 total bytes/.test(error.message),
  );
});

test("REVISION-BUNDLE-BOUND-001 accepted bundle tree reattestation rejects a post-intake oversized file without whole-file allocation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-revision-bundle-bound-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "checksums.json"), JSON.stringify({ algorithm: "sha256", files: {} }));
  const oversized = path.join(root, "huge.bin");
  await fs.writeFile(oversized, "");
  await fs.truncate(oversized, DEFAULT_ARCHIVE_LIMITS.maximumEntryUncompressedBytes + 1);

  await assert.rejects(
    () => attestAcceptedBundleAuthority(root, "a".repeat(64)),
    (error: unknown) => error instanceof RevisionError && error.code === "REVISION_BUNDLE_MUTATED" && /trusted limits/.test(error.message),
  );
});
