import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("run-store atomic writers sync directory metadata after rename", async () => {
  const source = await readFile(new URL("../src/run/run-store.ts", import.meta.url), "utf8");
  assert.match(source, /async function syncDirectoryMetadata\(directory: string\)/);
  assert.match(source, /await handle\.sync\(\)/);
  const jsonWriter = /export async function atomicWriteJson[\s\S]*?await rename\(temporary, filePath\);\s*await syncDirectoryMetadata\(directory\);[\s\S]*?export async function atomicWriteText/.exec(source);
  assert.ok(jsonWriter, "atomicWriteJson must fsync the parent directory after its atomic rename");
  const textWriter = /export async function atomicWriteText[\s\S]*?await rename\(temporary, filePath\);\s*await syncDirectoryMetadata\(directory\);[\s\S]*?export async function writeRunReceipt/.exec(source);
  assert.ok(textWriter, "atomicWriteText must fsync the parent directory after its atomic rename");
});
