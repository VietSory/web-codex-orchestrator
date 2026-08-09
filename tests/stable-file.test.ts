import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashStableFile, readStableFile, StableFileError } from "../src/shared/stable-file.js";

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

test("STABLE-FILE-001 bounded stable read returns exact bytes and identity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-stable-file-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "authority.json");
  const expected = Buffer.from("authority-bytes\n", "utf8");
  await fs.writeFile(file, expected);
  const snapshot = await readStableFile(file, 1024);
  assert.deepEqual(snapshot.bytes, expected);
  assert.equal(snapshot.identity.size, expected.byteLength);
});

test("STABLE-FILE-002 stable hash is chunked and exact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-stable-hash-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "payload.bin");
  const expected = Buffer.alloc(256 * 1024 + 17, 0x5a);
  await fs.writeFile(file, expected);
  const result = await hashStableFile(file, { maximumBytes: expected.byteLength, chunkBytes: 4096 });
  assert.equal(result.sha256, sha256(expected));
  assert.equal(result.identity.size, expected.byteLength);
});

test("STABLE-FILE-003 bounded read rejects oversized files before allocation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-stable-size-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "oversized.bin");
  await fs.writeFile(file, Buffer.alloc(1025));
  await assert.rejects(readStableFile(file, 1024), (error: unknown) => error instanceof StableFileError);
});

test("STABLE-FILE-004 final-component symlink is rejected instead of followed", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation may require developer privileges; Linux CI covers the no-follow boundary.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-stable-link-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  await fs.writeFile(target, "secret");
  await fs.symlink(target, link);
  await assert.rejects(readStableFile(link, 1024), (error: unknown) => error instanceof StableFileError);
});
