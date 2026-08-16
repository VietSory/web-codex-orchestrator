import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireExecutionLock, executionLockPath } from "../src/execution/execution-lock.js";
import { ExecutionError } from "../src/execution/errors.js";
import { acquireTicketFileLock, TicketFileLockError } from "../src/shared/ticket-file-lock.js";

const DIGEST = "d".repeat(64);
const STALE = `${JSON.stringify({ pid: 2_147_483_647, nonce: "00000000-0000-4000-8000-000000000000", timestamp: "2026-01-01T00:00:00.000Z" })}\n`;

async function temporaryRoot(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

test("execution lock fails closed on a well-formed stale owner instead of stealing authority", async (t) => {
  const root = await temporaryRoot("wco-execution-lock-stale-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "locks"));
  const target = executionLockPath(root, DIGEST);
  await writeFile(target, STALE, { mode: 0o600 });

  await assert.rejects(
    acquireExecutionLock(root, DIGEST),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_LOCKED" && /never auto-steals authority locks/i.test(error.message),
  );
  assert.equal(await readFile(target, "utf8"), STALE);
});

test("two stale-lock contenders both fail without deleting or replacing the stale inode", async (t) => {
  const root = await temporaryRoot("wco-execution-lock-stale-race-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "locks"));
  const target = executionLockPath(root, DIGEST);
  await writeFile(target, STALE, { mode: 0o600 });

  const outcomes = await Promise.allSettled([acquireExecutionLock(root, DIGEST), acquireExecutionLock(root, DIGEST)]);
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason instanceof ExecutionError && outcome.reason.code === "EXECUTION_LOCKED"));
  assert.equal(await readFile(target, "utf8"), STALE);
});

test("execution lock still rejects a second live owner", async (t) => {
  const root = await temporaryRoot("wco-execution-lock-live-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await acquireExecutionLock(root, DIGEST);
  await assert.rejects(
    acquireExecutionLock(root, DIGEST),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_LOCKED" && /live process/i.test(error.message),
  );
  await first.release();
});

test("execution lock fails closed on malformed stale state instead of deleting it", async (t) => {
  const root = await temporaryRoot("wco-execution-lock-invalid-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "locks"));
  const target = executionLockPath(root, DIGEST);
  await writeFile(target, "not-json\n", { mode: 0o600 });

  await assert.rejects(
    acquireExecutionLock(root, DIGEST),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_LOCKED" && /cannot be reclaimed safely/i.test(error.message),
  );
  assert.equal(await readFile(target, "utf8"), "not-json\n");
});

test("execution lock refuses a symlinked lock directory without writing outside state", async (t) => {
  const root = await temporaryRoot("wco-execution-lock-state-");
  const outside = await temporaryRoot("wco-execution-lock-outside-");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await symlink(outside, path.join(root, "locks"), "dir");

  await assert.rejects(
    acquireExecutionLock(root, DIGEST),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_LOCKED" && /unsafe/i.test(error.message),
  );
  assert.deepEqual(await readdir(outside), []);
});

test("ticket lock refuses symlinked parent ancestry before creating its lock directory", async (t) => {
  const root = await temporaryRoot("wco-ticket-lock-state-");
  const outside = await temporaryRoot("wco-ticket-lock-outside-");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await symlink(outside, path.join(root, "bridge"), "dir");

  await assert.rejects(
    acquireTicketFileLock(path.join(root, "bridge", "locks"), { timeoutMs: 0 }),
    (error: unknown) => error instanceof TicketFileLockError && error.code === "TICKET_LOCK_INVALID" && /parent directory is unsafe/i.test(error.message),
  );
  assert.deepEqual(await readdir(outside), []);
});
