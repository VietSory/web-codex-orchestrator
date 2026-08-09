import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

export type LockCode = "RUN_LOCKED" | "WATCH_LOCKED";

export class LockError extends Error {
  constructor(readonly code: LockCode, message: string) {
    super(message);
    this.name = "LockError";
  }
}

export interface LockHandle {
  path: string;
  release(): Promise<void>;
}

const MAX_LOCK_BYTES = 16 * 1024;

interface LockRecord {
  pid: number;
  nonce: string;
  timestamp: string;
}

function parseOwnedLock(raw: string): LockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return null;
    if (typeof value.nonce !== "string" || value.nonce.length < 16 || value.nonce.length > 256) return null;
    if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) return null;
    return { pid: Number(value.pid), nonce: value.nonce, timestamp: value.timestamp };
  } catch {
    return null;
  }
}

export async function acquireExclusiveLock(lockPath: string, code: LockCode): Promise<LockHandle> {
  const resolved = path.resolve(lockPath);
  const parentPath = path.dirname(resolved);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parent = await lstat(parentPath);
  if (parent.isSymbolicLink() || !parent.isDirectory() || await realpath(parentPath) !== parentPath) {
    throw new LockError(code, `Lock directory is unsafe: ${parentPath}`);
  }

  const pid = process.pid;
  const nonce = randomUUID();
  let handle;
  try {
    handle = await open(resolved, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(`${JSON.stringify({ pid, nonce, timestamp: new Date().toISOString() } satisfies LockRecord)}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LockError(code, `Lock already exists: ${resolved}`);
    throw error;
  }

  let released = false;
  return {
    path: resolved,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const info = await lstat(resolved);
        if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_LOCK_BYTES) return;
        const current = parseOwnedLock(await readFile(resolved, "utf8"));
        if (current?.pid !== pid || current.nonce !== nonce) return;
        await rm(resolved, { force: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

export function runLockPath(stateDirectory: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "locks", `run-${archiveSha256}.lock`);
}

export function watchLockPath(stateDirectory: string): string {
  return path.join(path.resolve(stateDirectory), "locks", "watch.lock");
}
