import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { ExecutionError } from "./errors.js";

export interface ExecutionLockHandle { path: string; release(): Promise<void>; }

export function executionLockPath(stateDirectory: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "locks", `execution-${archiveSha256}.lock`);
}

export async function acquireExecutionLock(stateDirectory: string, archiveSha256: string): Promise<ExecutionLockHandle> {
  const lockPath = executionLockPath(stateDirectory, archiveSha256);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const parent = await lstat(path.dirname(lockPath));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new ExecutionError("EXECUTION_LOCKED", "Execution lock directory is unsafe.");
  let handle;
  try {
    handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ExecutionError("EXECUTION_LOCKED", "Execution lock already exists.");
    throw error;
  }
  return { path: lockPath, async release() { await rm(lockPath, { force: false }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); } };
}
