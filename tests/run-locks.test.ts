import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireExclusiveLock, LockError } from "../src/run/locks.js";

test("RUN-LOCK-001 atomic lifecycle lock rejects a concurrent owner", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-run-lock-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "locks", "run.lock");
  const first = await acquireExclusiveLock(lockPath, "RUN_LOCKED");
  await assert.rejects(
    () => acquireExclusiveLock(lockPath, "RUN_LOCKED"),
    (error: unknown) => error instanceof LockError && error.code === "RUN_LOCKED",
  );
  await first.release();
  const second = await acquireExclusiveLock(lockPath, "RUN_LOCKED");
  await second.release();
});

test("RUN-LOCK-002 release preserves a replacement lock with another nonce", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-run-lock-replace-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "locks", "run.lock");
  const first = await acquireExclusiveLock(lockPath, "RUN_LOCKED");
  const replacement = {
    pid: process.pid,
    nonce: "33333333-3333-4333-8333-333333333333",
    timestamp: new Date().toISOString(),
  };
  await fs.writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  await first.release();
  assert.equal((JSON.parse(await fs.readFile(lockPath, "utf8")) as { nonce: string }).nonce, replacement.nonce);
});
