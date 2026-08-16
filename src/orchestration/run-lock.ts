import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { readStableFile, sameStableFileIdentity, type StableFileIdentity } from "../shared/stable-file.js";
import { acquireTicketFileLock, TicketFileLockError } from "../shared/ticket-file-lock.js";
import { OrchestrationError } from "./contracts.js";
import { prepareOrchestrationDirectory } from "./ledger.js";
import { orchestrationPaths } from "./paths.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_LOCK_BYTES = 16 * 1024;
type LockKind = "STATE_WRITER" | "TRANSITION_EXECUTION";

interface LockBody { version: "1.0"; kind: LockKind; pid: number; nonce: string; acquired_at: string; }
interface LockObservation {
  state: "LIVE" | "STALE";
  body: LockBody;
  identity: StableFileIdentity;
}
type LockInspection = { state: "MISSING" | "MALFORMED" } | LockObservation;
export interface RunLockHandle { lockPath: string; nonce: string; release(): Promise<void>; }

function identity(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":"); const taskId = runId.slice(0, split); const taskBundleSha256 = runId.slice(split + 1);
  if (split <= 0 || !taskId || !SHA256.test(taskBundleSha256)) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "run_id must be <task-id>:<task-bundle-sha256>.");
  return { taskId, taskBundleSha256 };
}

function stableIdentity(stats: Stats): StableFileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function parseLock(bytes: Buffer, expectedKind: LockKind): LockBody | null {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Partial<LockBody>;
  if (
    body.version !== "1.0" || body.kind !== expectedKind || !Number.isSafeInteger(body.pid) || (body.pid ?? 0) <= 0 ||
    typeof body.nonce !== "string" || body.nonce.length < 16 || body.nonce.length > 256 ||
    typeof body.acquired_at !== "string" || !Number.isFinite(Date.parse(body.acquired_at))
  ) return null;
  return body as LockBody;
}

async function inspectExistingLock(lockPath: string, expectedKind: LockKind): Promise<LockInspection> {
  const before = await fs.lstat(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!before) return { state: "MISSING" };
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_LOCK_BYTES) return { state: "MALFORMED" };
  try {
    const snapshot = await readStableFile(lockPath, MAX_LOCK_BYTES);
    const body = parseLock(snapshot.bytes, expectedKind);
    if (!body) return { state: "MALFORMED" };
    return { state: processIsAlive(body.pid) ? "LIVE" : "STALE", body, identity: snapshot.identity };
  } catch {
    const after = await fs.lstat(lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    return after ? { state: "MALFORMED" } : { state: "MISSING" };
  }
}

async function reclaimStableDeadLock(lockPath: string, observed: LockObservation): Promise<boolean> {
  if (observed.state !== "STALE" || processIsAlive(observed.body.pid)) return false;
  const current = await fs.lstat(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!current) return true;
  if (current.isSymbolicLink() || !current.isFile() || !sameStableFileIdentity(stableIdentity(current), observed.identity)) {
    throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Stale run lock changed while safe recovery was being attested.");
  }
  await fs.unlink(lockPath);
  return true;
}

async function installAuthorityLock(directory: string, lockPath: string, bytes: Buffer): Promise<StableFileIdentity | null> {
  const temporary = path.join(directory, `.${path.basename(lockPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: fs.FileHandle | null = null;
  let linked = false;
  let createdIdentity: StableFileIdentity | null = null;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const prepared = await handle.stat();
    if (!prepared.isFile() || prepared.size !== bytes.byteLength) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Prepared run lock is not a complete regular file.");
    createdIdentity = stableIdentity(prepared);
    await handle.close();
    handle = null;
    try { await fs.link(temporary, lockPath); linked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; }
    const installed = await fs.lstat(lockPath);
    if (installed.isSymbolicLink() || !installed.isFile() || !sameStableFileIdentity(stableIdentity(installed), createdIdentity)) {
      throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run lock changed while being atomically installed.");
    }
    return createdIdentity;
  } catch (error) {
    if (linked && createdIdentity) {
      const current = await fs.lstat(lockPath).catch(() => null);
      if (current && current.isFile() && !current.isSymbolicLink() && sameStableFileIdentity(stableIdentity(current), createdIdentity)) {
        await fs.unlink(lockPath).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function acquisitionGuardDirectory(directory: string, kind: LockKind): string {
  return path.join(directory, kind === "STATE_WRITER" ? "state-writer-acquire" : "transition-execution-acquire");
}

async function acquireLock(stateDirectory: string, runId: string, kind: LockKind, lockPath: string, options: { timeoutMs?: number; pollMs?: number; now?: () => Date } = {}): Promise<RunLockHandle> {
  const id = identity(runId); const paths = orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256); await prepareOrchestrationDirectory(stateDirectory, paths.directory);
  const timeoutMs = options.timeoutMs ?? 5_000; const pollMs = options.pollMs ?? 50;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run-lock timeout/poll bounds are invalid.");
  const started = Date.now(); const nonce = crypto.randomUUID(); const body: LockBody = { version: "1.0", kind, pid: process.pid, nonce, acquired_at: (options.now?.() ?? new Date()).toISOString() }; const bytes = canonicalJsonBuffer(body);
  if (bytes.byteLength > MAX_LOCK_BYTES) throw new OrchestrationError("ORCHESTRATION_LOCK_INVALID", "Run-lock body exceeds byte cap.");

  while (true) {
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, timeoutMs - elapsed);
    let guard;
    try {
      guard = await acquireTicketFileLock(acquisitionGuardDirectory(paths.directory, kind), { timeoutMs: remaining, pollMs });
    } catch (error) {
      if (error instanceof TicketFileLockError) throw new OrchestrationError(error.code === "TICKET_LOCKED" ? "ORCHESTRATION_LOCKED" : "ORCHESTRATION_LOCK_INVALID", `Could not serialize ${kind.toLowerCase()} lock acquisition: ${error.message}`);
      throw error;
    }

    let liveOwner = false;
    try {
      const observed = await inspectExistingLock(lockPath, kind);
      if (observed.state === "MALFORMED") {
        throw new OrchestrationError("ORCHESTRATION_LOCKED", `${kind.toLowerCase()} lock is malformed or unsafe; explicit operator repair is required.`);
      }
      if (observed.state === "LIVE") {
        liveOwner = true;
      } else {
        if (observed.state === "STALE") await reclaimStableDeadLock(lockPath, observed);
        const installedIdentity = await installAuthorityLock(paths.directory, lockPath, bytes);
        if (installedIdentity) {
          let released = false;
          return {
            lockPath,
            nonce,
            release: async () => {
              if (released) return;
              released = true;
              try {
                const snapshot = await readStableFile(lockPath, MAX_LOCK_BYTES);
                const parsed = parseLock(snapshot.bytes, kind);
                if (!parsed || parsed.pid !== process.pid || parsed.nonce !== nonce || !sameStableFileIdentity(snapshot.identity, installedIdentity)) return;
                const beforeRemove = await fs.lstat(lockPath);
                if (beforeRemove.isSymbolicLink() || !beforeRemove.isFile() || !sameStableFileIdentity(stableIdentity(beforeRemove), installedIdentity)) return;
                await fs.unlink(lockPath);
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== "ENOENT") return;
              }
            },
          };
        }
      }
    } finally {
      await guard.release().catch(() => undefined);
    }

    if (Date.now() - started >= timeoutMs) {
      const detail = liveOwner ? "another live process owns this run" : "lock acquisition did not converge";
      throw new OrchestrationError("ORCHESTRATION_LOCKED", `Could not acquire ${kind.toLowerCase()} lock within ${timeoutMs}ms: ${detail}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function acquireRunLock(stateDirectory: string, runId: string, options: { timeoutMs?: number; pollMs?: number; now?: () => Date } = {}): Promise<RunLockHandle> { const id = identity(runId); const paths = orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256); return await acquireLock(stateDirectory, runId, "STATE_WRITER", paths.lock, options); }
export async function acquireTransitionExecutionLock(stateDirectory: string, runId: string, options: { timeoutMs?: number; pollMs?: number; now?: () => Date } = {}): Promise<RunLockHandle> { const id = identity(runId); const paths = orchestrationPaths(stateDirectory, id.taskId, id.taskBundleSha256); return await acquireLock(stateDirectory, runId, "TRANSITION_EXECUTION", paths.execution_lock, options); }
export async function withRunLock<T>(stateDirectory: string, runId: string, action: () => Promise<T>, options?: { timeoutMs?: number; pollMs?: number; now?: () => Date }): Promise<T> { const lock = await acquireRunLock(stateDirectory, runId, options); try { return await action(); } finally { await lock.release(); } }
export async function withTransitionExecutionLock<T>(stateDirectory: string, runId: string, action: () => Promise<T>, options?: { timeoutMs?: number; pollMs?: number; now?: () => Date }): Promise<T> { const lock = await acquireTransitionExecutionLock(stateDirectory, runId, options); try { return await action(); } finally { await lock.release(); } }
