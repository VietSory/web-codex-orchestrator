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

test("execution lock safely reclaims a well-formed owner whose process is proven dead", async (t) => {
  const root = await temporaryRoot("wco-execution-lock-stale-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "locks"));
  const target = executionLockPath(root, DIGEST);
  await writeFile(target, STALE, { mode: 0o600 });

  const acquired = await acquireExecutionLock(root, DIGEST);
  const replacement = JSON.parse(await readFile(target, "utf8")) as { pid: number; nonce: string; timestamp: string };
  assert.equal(replacement.pid, process.pid);
  assert.notEqual(replacement.nonce, "00000000-0000-4000-8000-000000000000");
  assert.ok(Number.isFinite(Date.parse(replacement.timestamp)));
  await acquired.release();
});

test("two stale-lock contenders serialize recovery so exactly one live owner wins", async (t) => {
  const root = await temporaryRoot("wco-execution-lock-stale-race-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "locks"));
  const target = executionLockPath(root, DIGEST);
  await writeFile(target, STALE, { mode: 0o600 });

  const outcomes = await Promise.allSettled([acquireExecutionLock(root, DIGEST), acquireExecutionLock(root, DIGEST)]);
  const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireExecutionLock>>> => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof ExecutionError && rejected[0]!.reason.code === "EXECUTION_LOCKED" && /live process/i.test(rejected[0]!.reason.message));
  const current = JSON.parse(await readFile(target, "utf8")) as { pid: number };
  assert.equal(current.pid, process.pid);
  await fulfilled[0]!.value.release();
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
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_LOCKED" && /malformed or unsafe/i.test(error.message),
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
