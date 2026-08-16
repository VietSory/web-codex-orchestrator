import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireExclusiveLock, LockError } from "../src/run/locks.js";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

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

test("RUN-LOCK-003 reclaims a complete lifecycle lock owned by a dead process", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-run-lock-dead-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "locks", "run.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const pid = await exitedPid();
  await fs.writeFile(lockPath, `${JSON.stringify({
    pid,
    nonce: "44444444-4444-4444-8444-444444444444",
    timestamp: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  const lock = await acquireExclusiveLock(lockPath, "RUN_LOCKED");
  const current = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
  assert.equal(current.pid, process.pid);
  await lock.release();
  await assert.rejects(() => fs.access(lockPath));
});

test("RUN-LOCK-004 malformed lifecycle lock remains fail-closed", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-run-lock-malformed-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "locks", "run.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "{not-json", { mode: 0o600 });
  await assert.rejects(
    () => acquireExclusiveLock(lockPath, "RUN_LOCKED"),
    (error: unknown) => error instanceof LockError && error.code === "RUN_LOCKED",
  );
  assert.equal(await fs.readFile(lockPath, "utf8"), "{not-json");
});

test("RUN-LOCK-005 published lifecycle lock is always a complete parseable record", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-run-lock-complete-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "locks", "run.lock");
  const lock = await acquireExclusiveLock(lockPath, "RUN_LOCKED");
  const current = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number; nonce: string; timestamp: string };
  assert.equal(current.pid, process.pid);
  assert.ok(current.nonce.length >= 16);
  assert.ok(Number.isFinite(Date.parse(current.timestamp)));
  await lock.release();
});
