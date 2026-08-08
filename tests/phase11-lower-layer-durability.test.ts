import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installImmutableDurableExecutorStateFile, readStableExecutorStateFile, writeDurableExecutorStateFile } from "../src/executor/state-io.js";
import { ExecutorError } from "../src/executor/contracts.js";

const MAX = 1024;

test("P11-DURABLE-LOWER-001 mutable executor state replaces atomically and remains bounded/readable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-exec-durable-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "receipt.json");
  await writeDurableExecutorStateFile(target, Buffer.from("first"), MAX);
  await writeDurableExecutorStateFile(target, Buffer.from("second"), MAX);
  assert.equal((await readStableExecutorStateFile(target, MAX)).toString("utf8"), "second");
  const stat = await fs.stat(target);
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
});

test("P11-DURABLE-LOWER-002 immutable evidence is idempotent for identical bytes and rejects conflicts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-exec-immutable-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "evidence.json");
  await installImmutableDurableExecutorStateFile(target, Buffer.from("same"), MAX);
  await installImmutableDurableExecutorStateFile(target, Buffer.from("same"), MAX);
  await assert.rejects(
    () => installImmutableDurableExecutorStateFile(target, Buffer.from("different"), MAX),
    (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_STATE_INVALID",
  );
  assert.equal((await readStableExecutorStateFile(target, MAX)).toString("utf8"), "same");
});

test("P11-DURABLE-LOWER-003 durable state writer refuses a symlink destination", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-exec-symlink-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const victim = path.join(root, "victim.json");
  const target = path.join(root, "receipt.json");
  await fs.writeFile(victim, "victim");
  try {
    await fs.symlink(victim, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlink creation is unavailable on this Windows runner");
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => writeDurableExecutorStateFile(target, Buffer.from("replacement"), MAX),
    (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_STATE_INVALID",
  );
  assert.equal(await fs.readFile(victim, "utf8"), "victim");
});
