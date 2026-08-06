// Per-round mutual exclusion locking for Phase 7 Web Review Verdict Processing
import fs from "node:fs/promises";
import path from "node:path";
import { WebReviewError } from "./contracts.js";

export interface LockHandle {
  lockPath: string;
  release: () => Promise<void>;
}

/**
 * Acquire exclusive lock for a review round (`web-review.lock`).
 * Uses atomic flag creation (`wx`).
 */
export async function acquireReviewLock(
  lockPath: string,
  timeoutMs = 5000
): Promise<LockHandle> {
  const resolvedPath = path.resolve(lockPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  const start = Date.now();
  const pid = process.pid;

  while (true) {
    try {
      const lockContent = JSON.stringify({
        pid,
        acquired_at: new Date().toISOString(),
      }) + "\n";
      await fs.writeFile(resolvedPath, lockContent, { flag: "wx" });
      
      let released = false;
      return {
        lockPath: resolvedPath,
        release: async () => {
          if (released) return;
          released = true;
          await fs.unlink(resolvedPath).catch(() => undefined);
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Check for stale lock (older than 60 seconds)
        try {
          const stat = await fs.stat(resolvedPath);
          if (Date.now() - stat.mtimeMs > 60_000) {
            await fs.unlink(resolvedPath).catch(() => undefined);
            continue;
          }
        } catch {
          // Ignore stat errors, try again
        }

        if (Date.now() - start >= timeoutMs) {
          throw new WebReviewError(
            "WEB_REVIEW_LOCK_FAILED",
            `Could not acquire review lock at ${resolvedPath} within ${timeoutMs}ms.`
          );
        }
        await new Promise((res) => setTimeout(res, 100));
        continue;
      }
      throw new WebReviewError(
        "WEB_REVIEW_LOCK_FAILED",
        `Failed to acquire lock: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
