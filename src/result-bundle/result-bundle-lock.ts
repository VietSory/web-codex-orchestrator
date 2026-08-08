// Exclusive process lock for Phase 6 result bundle build.
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { ResultBundleError } from "./contracts.js";

const LOCK_TTL_MS = 10 * 60 * 1_000; // diagnostic threshold only; locks are never stolen automatically
const MAX_LOCK_BYTES = 16 * 1024;

interface LockData {
  version: "1.0";
  pid: number;
  created_at: string;
  run_id: string;
  nonce: string;
}

export interface ResultBundleLockHandle {
  release(): Promise<void>;
}

function isLockStale(lock: LockData): boolean {
  const created = Date.parse(lock.created_at);
  return Number.isFinite(created) && Date.now() - created > LOCK_TTL_MS;
}

function assertLockData(value: unknown): LockData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock is not a JSON object.");
  }
  const lock = value as Record<string, unknown>;
  if (
    lock.version !== "1.0" ||
    !Number.isSafeInteger(lock.pid) || Number(lock.pid) < 0 ||
    typeof lock.created_at !== "string" || !Number.isFinite(Date.parse(lock.created_at)) ||
    typeof lock.run_id !== "string" || lock.run_id.length === 0 || lock.run_id.length > 512 ||
    typeof lock.nonce !== "string" || !/^[a-f0-9]{64}$/.test(lock.nonce)
  ) {
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock has an invalid schema.");
  }
  return lock as unknown as LockData;
}

async function readStableLock(lockPath: string): Promise<{ lock: LockData; stat: Stats }> {
  const pathBefore = await fs.lstat(lockPath).catch((error) => {
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Cannot inspect Result Bundle lock: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > MAX_LOCK_BYTES) {
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock must be a bounded regular non-symlink file.");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(lockPath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Cannot safely open Result Bundle lock: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > MAX_LOCK_BYTES) {
      throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock changed before open.");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock grew while reading.");
    }
    const afterHandle = await handle.stat();
    const afterPath = await fs.lstat(lockPath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) {
      throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock changed while reading.");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); }
    catch { throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock is not valid JSON."); }
    return { lock: assertLockData(parsed), stat: before };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | directoryFlag);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EBADF") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Acquires the lock with one create-only write. Existing locks are diagnosed
 * but never deleted automatically, including stale locks.
 */
export async function acquireResultBundleLock(lockPath: string, runId: string): Promise<ResultBundleLockHandle> {
  const directory = path.dirname(lockPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const nonce = crypto.randomBytes(32).toString("hex");
  const lock: LockData = {
    version: "1.0",
    pid: process.pid,
    created_at: new Date().toISOString(),
    run_id: runId,
    nonce,
  };
  const bytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Cannot create Result Bundle lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    const existing = await readStableLock(lockPath);
    if (isLockStale(existing.lock)) {
      throw new ResultBundleError(
        "RESULT_STALE_LOCK",
        `A stale lock from PID ${existing.lock.pid} exists for run ${existing.lock.run_id}. Verify no live owner exists before removing it manually.`,
      );
    }
    throw new ResultBundleError(
      "RESULT_LOCKED",
      `Another process (PID ${existing.lock.pid}) is building the result bundle for run ${existing.lock.run_id}.`,
    );
  }

  const owned = await readStableLock(lockPath);
  if (owned.lock.nonce !== nonce || owned.lock.run_id !== runId || owned.lock.pid !== process.pid) {
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle lock ownership changed immediately after acquisition.");
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      let current: Awaited<ReturnType<typeof readStableLock>>;
      try { current = await readStableLock(lockPath); }
      catch (error) {
        if (error instanceof ResultBundleError && (error.message.includes("Cannot inspect") || error.message.includes("ENOENT"))) return;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (
        current.lock.nonce !== nonce ||
        current.stat.dev !== owned.stat.dev ||
        current.stat.ino !== owned.stat.ino
      ) {
        throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Refusing to release a Result Bundle lock no longer owned by this process.");
      }
      await fs.unlink(lockPath);
      await syncDirectory(directory);
    },
  };
}
