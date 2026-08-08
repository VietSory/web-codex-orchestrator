import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { OrchestrationError } from "./contracts.js";
import { prepareOrchestrationDirectory } from "./ledger.js";
import { orchestrationPaths } from "./paths.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_LOCK_BYTES = 16 * 1024;
type LockKind = "STATE_WRITER" | "TRANSITION_EXECUTION";

interface LockBody { version: "1.0"; kind: LockKind; pid: number; nonce: string; acquired_at: string; }
export interface RunLockHandle { lockPath: string; nonce: string; release(): Promise<void>; }

function identity(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":"); const taskId = runId.slice(0, split); const taskBundleSha256 = runId.slice(split + 1);
  if (split <= 0 || !taskId || !SHA256.test(taskBundleSha256)) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "run_id must be <task-id>:<task-bundle-sha256>.");
  return { taskId, taskBundleSha256 };
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

async function inspectExistingLock(lockPath: string, expectedKind: LockKind): Promise<"LIVE" | "STALE" | "MALFORMED"> {
  let stat: Stats; try { stat = await fs.lstat(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "STALE"; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LOCK_BYTES) return "MALFORMED";
  try {
    const body = JSON.parse(await fs.readFile(lockPath, "utf8")) as Partial<LockBody>;
    if (body.version !== "1.0" || body.kind !== expectedKind || !Number.isSafeInteger(body.pid) || (body.pid ?? 0) <= 0 || typeof body.nonce !== "string" || body.nonce.length < 16 || typeof body.acquired_at !== "string" || !Number.isFinite(Date.parse(body.acquired_at))) return "MALFORMED";
    try { process.kill(body.pid!, 0); return "LIVE"; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "STALE" : "LIVE"; }
  } catch { return "MALFORMED"; }
}

async function acquireLock(stateDirectory: string, runId: string, kind: LockKind, lockPath: string, options: { timeoutMs?: number; pollMs?: number; now?: () => Date } = {}): Promise<RunLockHandle> {
  const id = identity(runId); const paths = orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256); await prepareOrchestrationDirectory(stateDirectory, paths.directory);
  const timeoutMs = options.timeoutMs ?? 5_000; const pollMs = options.pollMs ?? 50;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run-lock timeout/poll bounds are invalid.");
  const started = Date.now(); const nonce = crypto.randomUUID(); const body: LockBody = { version: "1.0", kind, pid: process.pid, nonce, acquired_at: (options.now?.() ?? new Date()).toISOString() }; const bytes = canonicalJsonBuffer(body);
  if (bytes.byteLength > MAX_LOCK_BYTES) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run-lock body exceeds byte cap.");
  while (true) {
    try {
      const handle = await fs.open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600); let ownerStat: Stats;
      try { await handle.writeFile(bytes); await handle.sync(); ownerStat = await handle.stat(); const pathStat = await fs.lstat(lockPath); if (!ownerStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile() || !sameFile(ownerStat, pathStat)) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run lock changed while being acquired."); }
      catch (error) { await handle.close().catch(() => undefined); await fs.unlink(lockPath).catch(() => undefined); throw error; }
      let released = false;
      return { lockPath, nonce, release: async () => {
        if (released) return; released = true; let owned = false;
        try { const before = await fs.lstat(lockPath); if (!before.isSymbolicLink() && before.isFile() && sameFile(ownerStat, before)) { const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as Partial<LockBody>; owned = parsed.version === "1.0" && parsed.kind === kind && parsed.pid === process.pid && parsed.nonce === nonce; } }
        catch { owned = false; }
        finally { await handle.close().catch(() => undefined); }
        if (!owned) return;
        try { const after = await fs.lstat(lockPath); if (after.isSymbolicLink() || !after.isFile() || !sameFile(ownerStat, after)) return; await fs.unlink(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
      } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") { if (error instanceof OrchestrationError) throw error; throw new OrchestrationError("ORCHESTRATION_LOCK_FAILED", `Failed to acquire ${kind.toLowerCase()} lock: ${error instanceof Error ? error.message : String(error)}`); }
      const observed = await inspectExistingLock(lockPath, kind);
      if (Date.now() - started >= timeoutMs) { const recovery = observed === "LIVE" ? "another live process owns this run" : `${observed.toLowerCase()} lock requires explicit operator repair; WCO never auto-steals a lock`; throw new OrchestrationError("ORCHESTRATION_LOCKED", `Could not acquire ${kind.toLowerCase()} lock within ${timeoutMs}ms: ${recovery}.`); }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

export async function acquireRunLock(stateDirectory: string, runId: string, options: { timeoutMs?: number; pollMs?: number; now?: () => Date } = {}): Promise<RunLockHandle> { const id = identity(runId); const paths = orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256); return await acquireLock(stateDirectory, runId, "STATE_WRITER", paths.lock, options); }
export async function acquireTransitionExecutionLock(stateDirectory: string, runId: string, options: { timeoutMs?: number; pollMs?: number; now?: () => Date } = {}): Promise<RunLockHandle> { const id = identity(runId); const paths = orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256); return await acquireLock(stateDirectory, runId, "TRANSITION_EXECUTION", paths.execution_lock, options); }
export async function withRunLock<T>(stateDirectory: string, runId: string, action: () => Promise<T>, options?: { timeoutMs?: number; pollMs?: number; now?: () => Date }): Promise<T> { const lock = await acquireRunLock(stateDirectory, runId, options); try { return await action(); } finally { await lock.release(); } }
export async function withTransitionExecutionLock<T>(stateDirectory: string, runId: string, action: () => Promise<T>, options?: { timeoutMs?: number; pollMs?: number; now?: () => Date }): Promise<T> { const lock = await acquireTransitionExecutionLock(stateDirectory, runId, options); try { return await action(); } finally { await lock.release(); } }
