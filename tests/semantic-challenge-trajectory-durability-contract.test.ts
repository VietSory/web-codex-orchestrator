import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE = new URL("../src/semantic/challenge-trajectory-store.ts", import.meta.url);

test("semantic challenge trajectory durably fsyncs each managed directory entry before use", async () => {
  const source = await readFile(SOURCE, "utf8");
  const ensureStart = source.indexOf("async function ensureSafeDirectory");
  const ensureEnd = source.indexOf("function parseReceipt", ensureStart);
  assert.notEqual(ensureStart, -1, "ensureSafeDirectory must remain present");
  assert.notEqual(ensureEnd, -1, "ensureSafeDirectory boundary must remain inspectable");

  const ensureBody = source.slice(ensureStart, ensureEnd);
  assert.match(ensureBody, /const parent = current;[\s\S]*await mkdir\(current,[\s\S]*await assertSafeDirectory\(current\);[\s\S]*await syncDirectory\(parent\);[\s\S]*await assertSafeDirectory\(parent\);[\s\S]*await assertSafeDirectory\(current\);/);
});
