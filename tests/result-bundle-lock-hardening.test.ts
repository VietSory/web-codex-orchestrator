import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireResultBundleLock } from "../src/result-bundle/result-bundle-lock.js";
import { ResultBundleError } from "../src/result-bundle/contracts.js";

test("P6-LOCK-001 simultaneous acquisition has exactly one owner", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-p6-lock-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "handoff", "runs", "task", "a".repeat(64), "result-bundle.lock");
  const attempts = await Promise.allSettled([
    acquireResultBundleLock(lockPath, `task:${"a".repeat(64)}`),
    acquireResultBundleLock(lockPath, `task:${"a".repeat(64)}`),
  ]);
  const fulfilled = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireResultBundleLock>>> => result.status === "fulfilled");
  const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof ResultBundleError);
  assert.equal((rejected[0]!.reason as ResultBundleError).code, "RESULT_LOCKED");
  await fulfilled[0]!.value.release();
});

test("P6-LOCK-002 release never deletes a replaced foreign lock", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-p6-lock-replace-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "handoff", "runs", "task", "b".repeat(64), "result-bundle.lock");
  const handle = await acquireResultBundleLock(lockPath, `task:${"b".repeat(64)}`);
  await fs.unlink(lockPath);
  await fs.writeFile(lockPath, JSON.stringify({
    version: "1.0",
    pid: process.pid,
    created_at: new Date().toISOString(),
    run_id: `task:${"b".repeat(64)}`,
    nonce: "f".repeat(64),
  }), { mode: 0o600 });
  await assert.rejects(
    () => handle.release(),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_OPERATIONAL_ERROR",
  );
  assert.ok(await fs.lstat(lockPath));
});
