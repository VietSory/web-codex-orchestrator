import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { GitBoundaryError } from "../git/contracts.js";

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

export async function acquireExclusiveLock(lockPath: string, code: LockCode): Promise<LockHandle> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const parent = await lstat(path.dirname(lockPath));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new LockError(code, `Lock directory is unsafe: ${path.dirname(lockPath)}`);
  let handle;
  try {
    handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() })}\n`, "utf8");
    await handle.close();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LockError(code, `Lock already exists: ${lockPath}`);
    throw error;
  }
  return {
    path: lockPath,
    async release(): Promise<void> {
      await rm(lockPath, { force: false }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    },
  };
}

export function runLockPath(stateDirectory: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "locks", `run-${archiveSha256}.lock`);
}

export function watchLockPath(stateDirectory: string): string {
  return path.join(path.resolve(stateDirectory), "locks", "watch.lock");
}
