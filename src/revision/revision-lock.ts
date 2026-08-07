import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { RevisionError } from "./contracts.js";

export interface RevisionLockHandle {
  lockPath: string;
  nonce: string;
  release(): Promise<void>;
}

interface LockData {
  pid: number;
  nonce: string;
  acquired_at: string;
}

const MAX_LOCK_BYTES = 16 * 1024;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function inspectLock(lockPath: string): Promise<"LIVE" | "STALE" | "MALFORMED"> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "STALE";
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOCK_BYTES) return "MALFORMED";
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockData>;
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0 || typeof parsed.nonce !== "string" || parsed.nonce.length === 0 || typeof parsed.acquired_at !== "string") return "MALFORMED";
    return isProcessAlive(Number(parsed.pid)) ? "LIVE" : "STALE";
  } catch {
    return "MALFORMED";
  }
}

export async function acquireRevisionLock(lockPath: string, timeoutMs = 5000): Promise<RevisionLockHandle> {
  const resolved = path.resolve(lockPath);
  const parent = path.dirname(resolved);
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new RevisionError("REVISION_STATE_UNSAFE", `Revision lock parent is not a safe directory: ${parent}`);
  }

  const pid = process.pid;
  const nonce = crypto.randomUUID();
  const started = Date.now();
  while (true) {
    try {
      const content = JSON.stringify({ pid, nonce, acquired_at: new Date().toISOString() } satisfies LockData, null, 2) + "\n";
      await fs.writeFile(resolved, content, { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        lockPath: resolved,
        nonce,
        release: async () => {
          if (released) return;
          released = true;
          try {
            const stat = await fs.lstat(resolved);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOCK_BYTES) return;
            const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as Partial<LockData>;
            if (parsed.pid === pid && parsed.nonce === nonce) await fs.unlink(resolved).catch(() => undefined);
          } catch {
            // A missing, replaced or malformed lock is not ours to remove.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new RevisionError("REVISION_LOCKED", `Cannot acquire revision lock: ${error instanceof Error ? error.message : String(error)}`);
      }
      const observed = await inspectLock(resolved);
      if (Date.now() - started >= timeoutMs) {
        const reason = observed === "LIVE" ? "another live process owns the revision round" : `${observed.toLowerCase()} lock requires explicit operator recovery; automatic lock stealing is forbidden`;
        throw new RevisionError("REVISION_LOCKED", `Could not acquire revision lock at ${resolved}: ${reason}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
