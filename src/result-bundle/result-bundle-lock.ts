// Exclusive process lock for Phase 6 result bundle build
import fs from "node:fs";
import path from "node:path";
import { ResultBundleError } from "./contracts.js";

const LOCK_TTL_MS = 10 * 60 * 1_000; // 10 minutes

interface LockData {
  pid: number;
  created_at: string;
  run_id: string;
}

export interface ResultBundleLockHandle {
  release(): Promise<void>;
}

function isLockStale(lock: LockData): boolean {
  const created = new Date(lock.created_at).getTime();
  return Date.now() - created > LOCK_TTL_MS;
}

/**
 * Acquires an exclusive lock for a result bundle build.
 * Throws RESULT_LOCKED if live, RESULT_STALE_LOCK if stale.
 */
export async function acquireResultBundleLock(
  lockPath: string,
  runId: string
): Promise<ResultBundleLockHandle> {
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

  // Check for existing lock
  try {
    const existing = JSON.parse(await fs.promises.readFile(lockPath, "utf8")) as LockData;
    if (isLockStale(existing)) {
      throw new ResultBundleError(
        "RESULT_STALE_LOCK",
        `A stale lock from PID ${existing.pid} exists for run ${existing.run_id}. Remove ${lockPath} to continue.`
      );
    }
    throw new ResultBundleError(
      "RESULT_LOCKED",
      `Another process (PID ${existing.pid}) is building the result bundle for run ${existing.run_id}.`
    );
  } catch (error) {
    if (error instanceof ResultBundleError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Cannot read lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    // ENOENT = no lock exists, continue
  }

  // Write lock
  const lock: LockData = {
    pid: process.pid,
    created_at: new Date().toISOString(),
    run_id: runId,
  };
  await fs.promises.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");

  return {
    async release() {
      try {
        await fs.promises.unlink(lockPath);
      } catch {
        // Best-effort release
      }
    },
  };
}
