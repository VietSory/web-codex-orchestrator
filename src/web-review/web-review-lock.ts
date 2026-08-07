// Per-round mutual exclusion locking for Phase 7 Web Review Verdict Processing (P0-13)
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { WebReviewError } from "./contracts.js";

export interface LockHandle {
  lockPath: string;
  nonce: string;
  release: () => Promise<void>;
}

export interface LockData {
  pid: number;
  nonce: string;
  acquired_at: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only positive signal that the PID is gone. Permission or
    // platform-specific failures are treated as alive so lock recovery remains
    // fail-closed.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function inspectExistingLock(lockPath: string): Promise<"LIVE" | "STALE" | "MALFORMED"> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "STALE";
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return "MALFORMED";

  try {
    const content = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(content) as Partial<LockData>;
    if (
      !Number.isInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      typeof parsed.nonce !== "string" ||
      parsed.nonce.length === 0 ||
      typeof parsed.acquired_at !== "string"
    ) {
      return "MALFORMED";
    }
    return isProcessAlive(parsed.pid as number) ? "LIVE" : "STALE";
  } catch {
    return "MALFORMED";
  }
}

/**
 * Acquire exclusive lock for a review round (`web-review.lock`).
 *
 * Phase 7 deliberately never auto-deletes an existing lock. Automatic stale
 * lock stealing has an unavoidable read/unlink replacement race with a newly
 * acquired lock. A dead or malformed lock therefore fails closed and requires
 * explicit operator recovery outside this phase.
 */
export async function acquireReviewLock(
  lockPath: string,
  timeoutMs = 5000
): Promise<LockHandle> {
  const resolvedPath = path.resolve(lockPath);
  const parent = path.dirname(resolvedPath);
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new WebReviewError("WEB_REVIEW_LOCK_FAILED", `Review lock parent is not a safe directory: ${parent}`);
  }

  const start = Date.now();
  const pid = process.pid;
  const nonce = crypto.randomUUID();

  while (true) {
    try {
      const lockData: LockData = {
        pid,
        nonce,
        acquired_at: new Date().toISOString(),
      };
      const lockContent = JSON.stringify(lockData, null, 2) + "\n";
      await fs.writeFile(resolvedPath, lockContent, { flag: "wx" });

      let released = false;
      return {
        lockPath: resolvedPath,
        nonce,
        release: async () => {
          if (released) return;
          released = true;
          try {
            const stat = await fs.lstat(resolvedPath);
            if (stat.isSymbolicLink() || !stat.isFile()) return;
            const currentContent = await fs.readFile(resolvedPath, "utf8");
            const parsed: LockData = JSON.parse(currentContent);
            if (parsed && parsed.nonce === nonce && parsed.pid === pid) {
              await fs.unlink(resolvedPath).catch(() => undefined);
            }
          } catch {
            // Missing, malformed, or replaced lock is not ours to remove.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new WebReviewError(
          "WEB_REVIEW_LOCK_FAILED",
          `Failed to acquire lock: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const observed = await inspectExistingLock(resolvedPath);
      if (Date.now() - start >= timeoutMs) {
        const recovery = observed === "LIVE"
          ? "another live process owns the round"
          : `${observed.toLowerCase()} lock requires explicit operator cleanup; Phase 7 never auto-steals locks`;
        throw new WebReviewError(
          "WEB_REVIEW_LOCK_FAILED",
          `Could not acquire review lock at ${resolvedPath} within ${timeoutMs}ms: ${recovery}.`
        );
      }
      await new Promise((res) => setTimeout(res, 50));
    }
  }
}
