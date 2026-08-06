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
  } catch {
    return false;
  }
}

/**
 * Acquire exclusive lock for a review round (`web-review.lock`) with safe ownership nonces (P0-13).
 * Never steals a live lock based on mtime/TTL alone.
 * Release verifies nonce/identity before unlinking lock file.
 */
export async function acquireReviewLock(
  lockPath: string,
  timeoutMs = 5000
): Promise<LockHandle> {
  const resolvedPath = path.resolve(lockPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

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
            const currentContent = await fs.readFile(resolvedPath, "utf8");
            const parsed: LockData = JSON.parse(currentContent);
            if (parsed && parsed.nonce === nonce) {
              await fs.unlink(resolvedPath).catch(() => undefined);
            }
          } catch {
            // If lock file was already unlinked or non-matching, ignore
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Safe stale lock check: check if lock file is readable and holding PID is dead
        try {
          const content = await fs.readFile(resolvedPath, "utf8");
          const parsed: LockData = JSON.parse(content);
          if (parsed && typeof parsed.pid === "number") {
            if (!isProcessAlive(parsed.pid)) {
              // Dead process holding lock: safe to break stale lock
              await fs.unlink(resolvedPath).catch(() => undefined);
              continue;
            }
          }
        } catch {
          // If lock file is malformed JSON, break malformed lock
          await fs.unlink(resolvedPath).catch(() => undefined);
          continue;
        }

        if (Date.now() - start >= timeoutMs) {
          throw new WebReviewError(
            "WEB_REVIEW_LOCK_FAILED",
            `Could not acquire review lock at ${resolvedPath} within ${timeoutMs}ms.`
          );
        }
        await new Promise((res) => setTimeout(res, 50));
        continue;
      }
      throw new WebReviewError(
        "WEB_REVIEW_LOCK_FAILED",
        `Failed to acquire lock: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
