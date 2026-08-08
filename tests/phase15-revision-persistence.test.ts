import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RevisionError } from "../src/revision/contracts.js";
import {
  installImmutableDurableRevisionStateFile,
  writeDurableRevisionStateFile,
} from "../src/revision/revision-state-io.js";

const CAP = 1024;

async function readExisting(filePath: string): Promise<Buffer | null> {
  try { return await fs.readFile(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

test("P15-PERSIST-001 mutable revision state replaces exact bytes without temp-file residue", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-persist-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "receipt.json");
  await writeDurableRevisionStateFile(file, Buffer.from("first\n"), CAP);
  await writeDurableRevisionStateFile(file, Buffer.from("second\n"), CAP);
  assert.equal(await fs.readFile(file, "utf8"), "second\n");
  assert.deepEqual((await fs.readdir(root)).sort(), ["receipt.json"]);
});

test("P15-PERSIST-002 immutable revision state is idempotent for exact bytes and rejects conflicts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-immutable-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "decision.json");
  const bytes = Buffer.from("sealed\n");
  await installImmutableDurableRevisionStateFile(file, bytes, CAP, readExisting);
  await installImmutableDurableRevisionStateFile(file, bytes, CAP, readExisting);
  await assert.rejects(
    () => installImmutableDurableRevisionStateFile(file, Buffer.from("different\n"), CAP, readExisting),
    (error: unknown) => error instanceof RevisionError && error.code === "REVISION_STATE_INVALID",
  );
  assert.equal(await fs.readFile(file, "utf8"), "sealed\n");
  assert.deepEqual((await fs.readdir(root)).sort(), ["decision.json"]);
});

test("P15-PERSIST-003 mutable revision state refuses a symlink destination", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-symlink-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target.txt");
  const link = path.join(root, "receipt.json");
  await fs.writeFile(target, "protected\n");
  await fs.symlink(target, link);
  await assert.rejects(
    () => writeDurableRevisionStateFile(link, Buffer.from("overwrite\n"), CAP),
    (error: unknown) => error instanceof RevisionError && error.code === "REVISION_STATE_UNSAFE",
  );
  assert.equal(await fs.readFile(target, "utf8"), "protected\n");
});
