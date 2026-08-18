import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireTicketFileLock, TicketFileLockError } from "../src/shared/ticket-file-lock.js";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-ticket-lock-recovery-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "queue");
  await fs.mkdir(directory, { mode: 0o700 });
  return { root, directory };
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

test("ticket lock reclaims a complete older ticket owned by a dead process", async (t) => {
  const { directory } = await fixture(t);
  const pid = await exitedPid();
  await fs.writeFile(path.join(directory, "1.lock"), `${JSON.stringify({
    version: "1.0",
    pid,
    nonce: "11111111-1111-4111-8111-111111111111",
    created_at: new Date().toISOString(),
  })}\n`);

  const lock = await acquireTicketFileLock(directory, { timeoutMs: 1_000, pollMs: 10 });
  assert.equal(lock.sequence, 2);
  await assert.rejects(() => fs.access(path.join(directory, "1.lock")));
  await lock.release();
});

test("ticket lock never removes a live older owner", async (t) => {
  const { directory } = await fixture(t);
  const first = await acquireTicketFileLock(directory, { timeoutMs: 1_000, pollMs: 10 });
  await assert.rejects(
    () => acquireTicketFileLock(directory, { timeoutMs: 50, pollMs: 10 }),
    (error: unknown) => error instanceof TicketFileLockError && error.code === "TICKET_LOCKED",
  );
  await first.release();
});

test("ticket lock leaves malformed queue authority fail-closed", async (t) => {
  const { directory } = await fixture(t);
  await fs.writeFile(path.join(directory, "1.lock"), "{not-json");
  await assert.rejects(
    () => acquireTicketFileLock(directory, { timeoutMs: 50, pollMs: 10 }),
    (error: unknown) => error instanceof TicketFileLockError && error.code === "TICKET_LOCK_INVALID",
  );
  assert.equal(await fs.readFile(path.join(directory, "1.lock"), "utf8"), "{not-json");
});

test("ticket lock release preserves a replacement inode", async (t) => {
  const { directory } = await fixture(t);
  const lock = await acquireTicketFileLock(directory, { timeoutMs: 1_000, pollMs: 10 });
  await fs.unlink(lock.ticketPath);
  const replacement = {
    version: "1.0",
    pid: process.pid,
    nonce: "22222222-2222-4222-8222-222222222222",
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(lock.ticketPath, `${JSON.stringify(replacement)}\n`);
  await assert.rejects(
    () => lock.release(),
    (error: unknown) => error instanceof TicketFileLockError && error.code === "TICKET_LOCK_INVALID",
  );
  assert.equal((JSON.parse(await fs.readFile(lock.ticketPath, "utf8")) as { nonce: string }).nonce, replacement.nonce);
});

test("ticket lock allocation only exposes a complete parseable ticket file", async (t) => {
  const { directory } = await fixture(t);
  const lock = await acquireTicketFileLock(directory, { timeoutMs: 1_000, pollMs: 10 });
  const parsed = JSON.parse(await fs.readFile(lock.ticketPath, "utf8")) as { version: string; pid: number; nonce: string; created_at: string };
  assert.equal(parsed.version, "1.0");
  assert.equal(parsed.pid, process.pid);
  assert.match(parsed.nonce, /^[0-9a-f-]{36}$/i);
  assert.ok(Number.isFinite(Date.parse(parsed.created_at)));
  await lock.release();
});
