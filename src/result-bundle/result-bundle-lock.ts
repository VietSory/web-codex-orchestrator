// Exclusive process lock for Phase 6 result bundle build
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { ResultBundleError } from "./contracts.js";

const LOCK_TTL_MS = 10 * 60 * 1_000; // 10 minutes
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_ACQUIRE_RACE_RETRIES = 4;

interface LockData {
  pid: number;
  nonce: string;
  created_at: string;
  run_id: string;
}

export interface ResultBundleLockHandle {
  release(): Promise<void>;
}

function isLockStale(lock: LockData): boolean {
  const created = Date.parse(lock.created_at);
  return !Number.isFinite(created) || Date.now() - created > LOCK_TTL_MS;
}

function parseLock(raw: string): LockData | null {
  try {
    const value = JSON.parse(raw) as Partial<LockData>;
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return null;
    if (typeof value.nonce !== "string" || value.nonce.length < 16 || value.nonce.length > 256) return null;
    if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) return null;
    if (typeof value.run_id !== "string" || value.run_id.length === 0 || value.run_id.length > 4096) return null;
    return { pid: Number(value.pid), nonce: value.nonce, created_at: value.created_at, run_id: value.run_id };
  } catch {
    return null;
  }
}

async function readExistingLock(lockPath: string): Promise<LockData | "MISSING"> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "MISSING";
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Cannot inspect result lock: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOCK_BYTES) {
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Existing Result Bundle lock is not a bounded regular file; explicit operator recovery is required.");
  }
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Cannot read result lock: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseLock(raw);
  if (!parsed) throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Existing Result Bundle lock is malformed; explicit operator recovery is required.");
  return parsed;
}

/**
 * Acquires an exclusive lock for a result bundle build. Creation is atomic;
 * stale locks are never auto-stolen, and release removes only the exact owner
 * nonce written by this process.
 */
export async function acquireResultBundleLock(
  lockPath: string,
  runId: string
): Promise<ResultBundleLockHandle> {
  const resolved = path.resolve(lockPath);
  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || await fs.realpath(parent) !== parent) {
    throw new ResultBundleError("RESULT_STATE_DIR_UNSAFE", `Result Bundle lock parent is not a canonical real directory: ${parent}`);
  }

  const pid = process.pid;
  const nonce = crypto.randomUUID();
  const lock: LockData = {
    pid,
    nonce,
    created_at: new Date().toISOString(),
    run_id: runId,
  };
  const content = JSON.stringify(lock, null, 2) + "\n";

  for (let attempt = 0; attempt < MAX_ACQUIRE_RACE_RETRIES; attempt += 1) {
    try {
      await fs.writeFile(resolved, content, { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const stat = await fs.lstat(resolved);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOCK_BYTES) return;
            const current = parseLock(await fs.readFile(resolved, "utf8"));
            if (current?.pid === pid && current.nonce === nonce && current.run_id === runId) {
              await fs.unlink(resolved).catch(() => undefined);
            }
          } catch {
            // Missing, malformed, or replaced lock is not ours to remove.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Cannot acquire result lock: ${error instanceof Error ? error.message : String(error)}`);
      }
      const existing = await readExistingLock(resolved);
      if (existing === "MISSING") continue;
      if (isLockStale(existing)) {
        throw new ResultBundleError(
          "RESULT_STALE_LOCK",
          `A stale lock from PID ${existing.pid} exists for run ${existing.run_id}. Explicit operator recovery is required; automatic lock stealing is forbidden.`
        );
      }
      throw new ResultBundleError(
        "RESULT_LOCKED",
        `Another process (PID ${existing.pid}) is building the result bundle for run ${existing.run_id}.`
      );
    }
  }

  throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock path changed repeatedly during atomic acquisition.");
}
