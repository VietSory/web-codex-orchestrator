import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireExecutionLock, executionLockPath } from "../src/execution/execution-lock.js";
import { ExecutionError } from "../src/execution/errors.js";

const ARCHIVE_SHA = "d".repeat(64);

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-execution-lock-recovery-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "locks"), { mode: 0o700 });
  return { root, lockPath: executionLockPath(root, ARCHIVE_SHA) };
}

test("execution lock reclaims a complete lock owned by a dead process", async (t) => {
  const { root, lockPath } = await fixture(t);
  const pid = await exitedPid();
  await fs.writeFile(lockPath, `${JSON.stringify({
    pid,
    nonce: "11111111-1111-4111-8111-111111111111",
    timestamp: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  const lock = await acquireExecutionLock(root, ARCHIVE_SHA);
  assert.equal((JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number }).pid, process.pid);
  await lock.release();
  await assert.rejects(() => fs.access(lockPath));
});

test("execution lock never steals a live owner", async (t) => {
  const { root } = await fixture(t);
  const first = await acquireExecutionLock(root, ARCHIVE_SHA);
  await assert.rejects(
    () => acquireExecutionLock(root, ARCHIVE_SHA),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_LOCKED",
  );
  await first.release();
});

test("execution lock leaves malformed authority fail-closed", async (t) => {
  const { root, lockPath } = await fixture(t);
  await fs.writeFile(lockPath, "{not-json", { mode: 0o600 });
  await assert.rejects(
    () => acquireExecutionLock(root, ARCHIVE_SHA),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_LOCKED",
  );
  assert.equal(await fs.readFile(lockPath, "utf8"), "{not-json");
});

test("execution lock release preserves a replacement inode", async (t) => {
  const { root, lockPath } = await fixture(t);
  const first = await acquireExecutionLock(root, ARCHIVE_SHA);
  await fs.unlink(lockPath);
  const replacement = {
    pid: process.pid,
    nonce: "22222222-2222-4222-8222-222222222222",
    timestamp: new Date().toISOString(),
  };
  await fs.writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  await first.release();
  assert.equal((JSON.parse(await fs.readFile(lockPath, "utf8")) as { nonce: string }).nonce, replacement.nonce);
});
