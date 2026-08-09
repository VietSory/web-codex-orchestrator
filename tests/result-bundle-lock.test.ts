import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireResultBundleLock } from "../src/result-bundle/result-bundle-lock.js";
import { ResultBundleError } from "../src/result-bundle/contracts.js";

async function rootFixture(t: test.TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-result-lock-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("RESULT-LOCK-001 concurrent acquisition has exactly one atomic owner", async (t) => {
  const root = await rootFixture(t);
  const lockPath = path.join(root, "state", "result.lock");
  const [first, second] = await Promise.allSettled([
    acquireResultBundleLock(lockPath, "run-a"),
    acquireResultBundleLock(lockPath, "run-b"),
  ]);

  const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
  const rejected = [first, second].filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.status === "rejected");
  assert.ok(rejected[0]!.reason instanceof ResultBundleError);
  assert.equal(rejected[0]!.reason.code, "RESULT_LOCKED");

  if (first.status === "fulfilled") await first.value.release();
  if (second.status === "fulfilled") await second.value.release();
  await assert.rejects(() => fs.lstat(lockPath), { code: "ENOENT" });
});

test("RESULT-LOCK-002 stale locks fail closed and are never auto-stolen", async (t) => {
  const root = await rootFixture(t);
  const lockPath = path.join(root, "state", "result.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, `${JSON.stringify({
    pid: 12345,
    nonce: "11111111-1111-4111-8111-111111111111",
    created_at: "2000-01-01T00:00:00.000Z",
    run_id: "stale-run",
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    () => acquireResultBundleLock(lockPath, "new-run"),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_STALE_LOCK",
  );
  assert.equal((JSON.parse(await fs.readFile(lockPath, "utf8")) as { run_id: string }).run_id, "stale-run");
});

test("RESULT-LOCK-003 release never removes a replaced lock owned by another nonce", async (t) => {
  const root = await rootFixture(t);
  const lockPath = path.join(root, "state", "result.lock");
  const handle = await acquireResultBundleLock(lockPath, "run-a");
  const replacement = {
    pid: process.pid,
    nonce: "22222222-2222-4222-8222-222222222222",
    created_at: new Date().toISOString(),
    run_id: "run-b",
  };
  await fs.writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

  await handle.release();
  assert.equal((JSON.parse(await fs.readFile(lockPath, "utf8")) as { nonce: string }).nonce, replacement.nonce);
});

test("RESULT-LOCK-004 symbolic-link lock parents are rejected", async (t) => {
  const root = await rootFixture(t);
  const realParent = path.join(root, "real-state");
  const linkedParent = path.join(root, "linked-state");
  await fs.mkdir(realParent);
  await fs.symlink(realParent, linkedParent, "dir");

  await assert.rejects(
    () => acquireResultBundleLock(path.join(linkedParent, "result.lock"), "run-a"),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_STATE_DIR_UNSAFE",
  );
});
