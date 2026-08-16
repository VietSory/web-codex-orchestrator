import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { readStableFile, sameStableFileIdentity, type StableFileIdentity } from "../shared/stable-file.js";
import { ExecutionError } from "./errors.js";

export interface ExecutionLockHandle { path: string; release(): Promise<void>; }

const MAX_LOCK_BYTES = 16 * 1024;

interface ExecutionLockRecord {
  pid: number;
  nonce: string;
  timestamp: string;
}

function parseLock(raw: string): ExecutionLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ExecutionLockRecord>;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null;
    if (typeof value.nonce !== "string" || value.nonce.length < 16 || value.nonce.length > 256) return null;
    if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) return null;
    return { pid: Number(value.pid), nonce: value.nonce, timestamp: value.timestamp };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function identity(stats: Stats): StableFileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

async function prepareLockDirectory(stateDirectory: string, parentPath: string): Promise<void> {
  const stateRoot = path.resolve(stateDirectory);
  let stateInfo: Stats;
  try { stateInfo = await lstat(stateRoot); }
  catch (error) { throw new ExecutionError("EXECUTION_LOCKED", `Execution state directory is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory() || await realpath(stateRoot) !== stateRoot) {
    throw new ExecutionError("EXECUTION_LOCKED", "Execution state directory is unsafe.");
  }
  if (path.dirname(parentPath) !== stateRoot) throw new ExecutionError("EXECUTION_LOCKED", "Execution lock directory escapes the state root.");
  try { await mkdir(parentPath, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const parent = await lstat(parentPath);
  if (parent.isSymbolicLink() || !parent.isDirectory() || await realpath(parentPath) !== parentPath) {
    throw new ExecutionError("EXECUTION_LOCKED", "Execution lock directory is unsafe.");
  }
}

async function inspectExistingLock(lockPath: string): Promise<{
  state: "missing" | "live" | "stale" | "invalid";
  identity?: StableFileIdentity;
}> {
  let before: Stats;
  try { before = await lstat(lockPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_LOCK_BYTES) return { state: "invalid" };
  try {
    const snapshot = await readStableFile(lockPath, MAX_LOCK_BYTES);
    const record = parseLock(snapshot.bytes.toString("utf8"));
    if (!record) return { state: "invalid" };
    return { state: processIsAlive(record.pid) ? "live" : "stale", identity: snapshot.identity };
  } catch {
    return { state: "invalid" };
  }
}

export function executionLockPath(stateDirectory: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "locks", `execution-${archiveSha256}.lock`);
}

export async function acquireExecutionLock(stateDirectory: string, archiveSha256: string): Promise<ExecutionLockHandle> {
  const lockPath = executionLockPath(stateDirectory, archiveSha256);
  const parentPath = path.dirname(lockPath);
  await prepareLockDirectory(stateDirectory, parentPath);

  const pid = process.pid;
  const nonce = randomUUID();
  let ownedIdentity: StableFileIdentity | undefined;

  while (!ownedIdentity) {
    let handle;
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(`${JSON.stringify({ pid, nonce, timestamp: new Date().toISOString() } satisfies ExecutionLockRecord)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      const snapshot = await readStableFile(lockPath, MAX_LOCK_BYTES);
      const record = parseLock(snapshot.bytes.toString("utf8"));
      if (record?.pid !== pid || record.nonce !== nonce) {
        throw new ExecutionError("EXECUTION_LOCKED", "Execution lock ownership changed during acquisition.");
      }
      ownedIdentity = snapshot.identity;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await inspectExistingLock(lockPath);
      if (existing.state === "missing") continue;
      if (existing.state === "live") throw new ExecutionError("EXECUTION_LOCKED", "Execution lock is owned by another live process.");
      if (existing.state !== "stale" || !existing.identity) {
        throw new ExecutionError("EXECUTION_LOCKED", "Execution lock exists but cannot be reclaimed safely.");
      }
      const beforeRemove = await lstat(lockPath).catch((checkError: unknown) => {
        if ((checkError as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw checkError;
      });
      if (!beforeRemove) continue;
      if (beforeRemove.isSymbolicLink() || !beforeRemove.isFile() || !sameStableFileIdentity(identity(beforeRemove), existing.identity)) {
        throw new ExecutionError("EXECUTION_LOCKED", "Stale execution lock changed before recovery.");
      }
      try { await rm(lockPath, { force: false }); }
      catch (removeError) {
        if ((removeError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new ExecutionError("EXECUTION_LOCKED", `Stale execution lock could not be recovered: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
      }
    }
  }

  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      try {
        const snapshot = await readStableFile(lockPath, MAX_LOCK_BYTES);
        const current = parseLock(snapshot.bytes.toString("utf8"));
        if (current?.pid !== pid || current.nonce !== nonce || !sameStableFileIdentity(snapshot.identity, ownedIdentity)) return;
        const beforeRemove = await lstat(lockPath);
        if (beforeRemove.isSymbolicLink() || !beforeRemove.isFile() || !sameStableFileIdentity(identity(beforeRemove), ownedIdentity)) return;
        await rm(lockPath, { force: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
