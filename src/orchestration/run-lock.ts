import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { OrchestrationError } from "./contracts.js";
import { prepareOrchestrationDirectory } from "./ledger.js";
import { orchestrationPaths } from "./paths.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_LOCK_BYTES = 16 * 1024;

interface LockBody {
  version: "1.0";
  pid: number;
  nonce: string;
  acquired_at: string;
}

export interface RunLockHandle {
  lockPath: string;
  nonce: string;
  release(): Promise<void>;
}

function identity(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split);
  const taskBundleSha256 = runId.slice(split + 1);
  if (split <= 0 || !taskId || !SHA256.test(taskBundleSha256)) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "run_id must be <task-id>:<task-bundle-sha256>.");
  return { taskId, taskBundleSha256 };
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectExistingLock(lockPath: string): Promise<"LIVE" | "STALE" | "MALFORMED"> {
  let stat: Stats;
  try { stat = await fs.lstat(lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "STALE"; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOCK_BYTES) return "MALFORMED";
  try {
    const body = JSON.parse(await fs.readFile(lockPath, "utf8")) as Partial<LockBody>;
    if (body.version !== "1.0" || !Number.isSafeInteger(body.pid) || (body.pid ?? 0) <= 0 || typeof body.nonce !== "string" || body.nonce.length < 16 || typeof body.acquired_at !== "string" || !Number.isFinite(Date.parse(body.acquired_at))) return "MALFORMED";
    try { process.kill(body.pid!, 0); return "LIVE"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "STALE" : "LIVE"; }
  } catch { return "MALFORMED"; }
}

export async function acquireRunLock(stateDirectory: string, runId: string, options: { timeoutMs?: number; pollMs?: number; now?: () => Date } = {}): Promise<RunLockHandle> {
  const id = identity(runId);
  const paths = orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256);
  await prepareOrchestrationDirectory(stateDirectory, paths.directory);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 50;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run-lock timeout/poll bounds are invalid.");
  const started = Date.now();
  const nonce = crypto.randomUUID();
  const body: LockBody = { version: "1.0", pid: process.pid, nonce, acquired_at: (options.now?.() ?? new Date()).toISOString() };
  const bytes = canonicalJsonBuffer(body);
  if (bytes.byteLength > MAX_LOCK_BYTES) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run-lock body exceeds byte cap.");

  while (true) {
    try {
      const handle = await fs.open(paths.lock, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      let ownerStat: Stats;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        ownerStat = await handle.stat();
        const pathStat = await fs.lstat(paths.lock);
        if (!ownerStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile() || !sameFile(ownerStat, pathStat)) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run lock changed while being acquired.");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.unlink(paths.lock).catch(() => undefined);
        throw error;
      }
      let released = false;
      return {
        lockPath: paths.lock,
        nonce,
        release: async () => {
          if (released) return;
          released = true;
          try {
            const before = await fs.lstat(paths.lock);
            if (before.isSymbolicLink() || !before.isFile() || !sameFile(ownerStat, before)) return;
            const current = await fs.readFile(paths.lock, "utf8");
            const parsed = JSON.parse(current) as Partial<LockBody>;
            if (parsed.version !== "1.0" || parsed.pid !== process.pid || parsed.nonce !== nonce) return;
            await handle.close();
            const after = await fs.lstat(paths.lock);
            if (after.isSymbolicLink() || !after.isFile() || !sameFile(ownerStat, after)) return;
            await fs.unlink(paths.lock);
          } catch (error) {
            await handle.close().catch(() => undefined);
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (error instanceof OrchestrationError) throw error;
        throw new OrchestrationError("ORCHESTRATION_LOCK_FAILED", `Failed to acquire run lock: ${error instanceof Error ? error.message : String(error)}`);
      }
      const observed = await inspectExistingLock(paths.lock);
      if (Date.now() - started >= timeoutMs) {
        const recovery = observed === "LIVE" ? "another live process owns this run" : `${observed.toLowerCase()} lock requires explicit operator repair; WCO never auto-steals a lock`;
        throw new OrchestrationError("ORCHESTRATION_LOCKED", `Could not acquire run lock within ${timeoutMs}ms: ${recovery}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

export async function withRunLock<T>(stateDirectory: string, runId: string, action: () => Promise<T>, options?: { timeoutMs?: number; pollMs?: number; now?: () => Date }): Promise<T> {
  const lock = await acquireRunLock(stateDirectory, runId, options);
  try { return await action(); }
  finally { await lock.release(); }
}
