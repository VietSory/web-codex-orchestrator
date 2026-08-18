import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { acquireExclusiveLock, LockError } from "../run/locks.js";
import { ExecutionError } from "./errors.js";

export interface ExecutionLockHandle { path: string; release(): Promise<void>; }

async function prepareLockDirectory(stateDirectory: string, parentPath: string): Promise<void> {
  const stateRoot = path.resolve(stateDirectory);
  let stateInfo;
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

export function executionLockPath(stateDirectory: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "locks", `execution-${archiveSha256}.lock`);
}

export async function acquireExecutionLock(stateDirectory: string, archiveSha256: string): Promise<ExecutionLockHandle> {
  const lockPath = executionLockPath(stateDirectory, archiveSha256);
  await prepareLockDirectory(stateDirectory, path.dirname(lockPath));
  try {
    const lock = await acquireExclusiveLock(lockPath, "EXECUTION_LOCKED");
    return { path: lock.path, release: async () => await lock.release() };
  } catch (error) {
    if (error instanceof LockError) throw new ExecutionError("EXECUTION_LOCKED", error.message);
    throw error;
  }
}
