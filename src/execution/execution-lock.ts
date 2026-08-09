import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
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
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return null;
    if (typeof value.nonce !== "string" || value.nonce.length < 16 || value.nonce.length > 256) return null;
    if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) return null;
    return { pid: Number(value.pid), nonce: value.nonce, timestamp: value.timestamp };
  } catch {
    return null;
  }
}

export function executionLockPath(stateDirectory: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "locks", `execution-${archiveSha256}.lock`);
}

export async function acquireExecutionLock(stateDirectory: string, archiveSha256: string): Promise<ExecutionLockHandle> {
  const lockPath = executionLockPath(stateDirectory, archiveSha256);
  const parentPath = path.dirname(lockPath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parent = await lstat(parentPath);
  if (parent.isSymbolicLink() || !parent.isDirectory() || await realpath(parentPath) !== parentPath) {
    throw new ExecutionError("EXECUTION_LOCKED", "Execution lock directory is unsafe.");
  }

  const pid = process.pid;
  const nonce = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(`${JSON.stringify({ pid, nonce, timestamp: new Date().toISOString() } satisfies ExecutionLockRecord)}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ExecutionError("EXECUTION_LOCKED", "Execution lock already exists.");
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      try {
        const info = await lstat(lockPath);
        if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_LOCK_BYTES) return;
        const current = parseLock(await readFile(lockPath, "utf8"));
        if (current?.pid !== pid || current.nonce !== nonce) return;
        await rm(lockPath, { force: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
