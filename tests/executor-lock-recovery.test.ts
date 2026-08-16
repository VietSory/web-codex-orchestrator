import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutorError } from "../src/executor/contracts.js";
import { executorPaths, prepareExecutorDirectory } from "../src/executor/paths.js";
import { acquireExecutorLock, releaseExecutorLock } from "../src/executor/store.js";

const TASK_ID = "executor-lock-recovery";
const BUNDLE_SHA = "b".repeat(64);
const ARTIFACT_SHA = "c".repeat(64);

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-executor-lock-recovery-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const paths = executorPaths(root, TASK_ID, BUNDLE_SHA, ARTIFACT_SHA);
  await prepareExecutorDirectory(root, paths.directory);
  return { root, paths };
}

test("executor lock recovery reclaims a stable lock owned by a dead process", async (t) => {
  const { root, paths } = await fixture(t);
  const pid = await exitedPid();
  await fs.writeFile(paths.lock, JSON.stringify({
    pid,
    nonce: "1".repeat(48),
    created_at: new Date().toISOString(),
  }));

  const lock = await acquireExecutorLock(root, TASK_ID, BUNDLE_SHA, ARTIFACT_SHA);
  const current = JSON.parse(await fs.readFile(paths.lock, "utf8")) as { pid: number; nonce: string };
  assert.equal(current.pid, process.pid);
  assert.equal(current.nonce, lock.nonce);
  await releaseExecutorLock(lock);
  await assert.rejects(() => fs.access(paths.lock));
});

test("executor lock recovery never steals a live owner", async (t) => {
  const { root } = await fixture(t);
  const first = await acquireExecutorLock(root, TASK_ID, BUNDLE_SHA, ARTIFACT_SHA);
  await assert.rejects(
    () => acquireExecutorLock(root, TASK_ID, BUNDLE_SHA, ARTIFACT_SHA),
    (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_LOCKED",
  );
  await releaseExecutorLock(first);
});

test("executor lock recovery leaves malformed authority state fail-closed", async (t) => {
  const { root, paths } = await fixture(t);
  await fs.writeFile(paths.lock, "{not-json");
  await assert.rejects(
    () => acquireExecutorLock(root, TASK_ID, BUNDLE_SHA, ARTIFACT_SHA),
    (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_LOCKED",
  );
  assert.equal(await fs.readFile(paths.lock, "utf8"), "{not-json");
});

test("executor lock release preserves a replacement inode", async (t) => {
  const { root, paths } = await fixture(t);
  const first = await acquireExecutorLock(root, TASK_ID, BUNDLE_SHA, ARTIFACT_SHA);
  await fs.unlink(paths.lock);
  const replacement = {
    pid: process.pid,
    nonce: "2".repeat(48),
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(paths.lock, JSON.stringify(replacement));
  await releaseExecutorLock(first);
  assert.equal((JSON.parse(await fs.readFile(paths.lock, "utf8")) as { nonce: string }).nonce, replacement.nonce);
});

test("executor lock installation always exposes a complete parseable authority record", async (t) => {
  const { root, paths } = await fixture(t);
  const lock = await acquireExecutorLock(root, TASK_ID, BUNDLE_SHA, ARTIFACT_SHA);
  const bytes = await fs.readFile(paths.lock, "utf8");
  const parsed = JSON.parse(bytes) as { pid: number; nonce: string; created_at: string };
  assert.equal(parsed.pid, process.pid);
  assert.match(parsed.nonce, /^[a-f0-9]{48}$/);
  assert.ok(Number.isFinite(Date.parse(parsed.created_at)));
  await releaseExecutorLock(lock);
});
