import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrchestrationError } from "../src/orchestration/contracts.js";
import { prepareOrchestrationDirectory } from "../src/orchestration/ledger.js";
import { orchestrationPaths } from "../src/orchestration/paths.js";
import { acquireRunLock, acquireTransitionExecutionLock } from "../src/orchestration/run-lock.js";

const SHA = "a".repeat(64);
const RUN_ID = `lock-recovery:${SHA}`;

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

async function fixture(t: Parameters<typeof test>[1] extends (...args: infer A) => unknown ? A[0] : never) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-orchestration-lock-recovery-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const paths = orchestrationPaths(root, "lock-recovery", SHA);
  await prepareOrchestrationDirectory(root, paths.directory);
  return { root, paths };
}

test("orchestration lock recovery reclaims a stable transition lock owned by a dead process", async (t) => {
  const { root, paths } = await fixture(t);
  const pid = await exitedPid();
  await fs.writeFile(paths.execution_lock, JSON.stringify({
    version: "1.0",
    kind: "TRANSITION_EXECUTION",
    pid,
    nonce: "11111111-1111-4111-8111-111111111111",
    acquired_at: new Date().toISOString(),
  }));

  const lock = await acquireTransitionExecutionLock(root, RUN_ID, { timeoutMs: 1_000, pollMs: 10 });
  const current = JSON.parse(await fs.readFile(paths.execution_lock, "utf8")) as { pid: number; nonce: string };
  assert.equal(current.pid, process.pid);
  assert.equal(current.nonce, lock.nonce);
  await lock.release();
  await assert.rejects(() => fs.access(paths.execution_lock));
});

test("orchestration lock recovery reclaims a stable state-writer lock owned by a dead process", async (t) => {
  const { root, paths } = await fixture(t);
  const pid = await exitedPid();
  await fs.writeFile(paths.lock, JSON.stringify({
    version: "1.0",
    kind: "STATE_WRITER",
    pid,
    nonce: "22222222-2222-4222-8222-222222222222",
    acquired_at: new Date().toISOString(),
  }));

  const lock = await acquireRunLock(root, RUN_ID, { timeoutMs: 1_000, pollMs: 10 });
  assert.equal((JSON.parse(await fs.readFile(paths.lock, "utf8")) as { pid: number }).pid, process.pid);
  await lock.release();
});

test("orchestration lock recovery never steals a live transition owner", async (t) => {
  const { root } = await fixture(t);
  const first = await acquireTransitionExecutionLock(root, RUN_ID, { timeoutMs: 1_000, pollMs: 10 });
  await assert.rejects(
    () => acquireTransitionExecutionLock(root, RUN_ID, { timeoutMs: 50, pollMs: 10 }),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_LOCKED",
  );
  await first.release();
});

test("orchestration lock recovery leaves malformed authority state fail-closed", async (t) => {
  const { root, paths } = await fixture(t);
  await fs.writeFile(paths.execution_lock, "{not-json");
  await assert.rejects(
    () => acquireTransitionExecutionLock(root, RUN_ID, { timeoutMs: 50, pollMs: 10 }),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_LOCKED",
  );
  assert.equal(await fs.readFile(paths.execution_lock, "utf8"), "{not-json");
});

test("orchestration lock release preserves a replacement inode", async (t) => {
  const { root, paths } = await fixture(t);
  const first = await acquireTransitionExecutionLock(root, RUN_ID, { timeoutMs: 1_000, pollMs: 10 });
  await fs.unlink(paths.execution_lock);
  const replacement = {
    version: "1.0",
    kind: "TRANSITION_EXECUTION",
    pid: process.pid,
    nonce: "33333333-3333-4333-8333-333333333333",
    acquired_at: new Date().toISOString(),
  };
  await fs.writeFile(paths.execution_lock, JSON.stringify(replacement));
  await first.release();
  assert.equal((JSON.parse(await fs.readFile(paths.execution_lock, "utf8")) as { nonce: string }).nonce, replacement.nonce);
});
