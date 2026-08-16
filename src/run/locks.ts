import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, link, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { readStableFile, sameStableFileIdentity, type StableFileIdentity } from "../shared/stable-file.js";
import { acquireTicketFileLock, TicketFileLockError } from "../shared/ticket-file-lock.js";

export type LockCode = "RUN_LOCKED" | "WATCH_LOCKED";

export class LockError extends Error {
  constructor(readonly code: LockCode, message: string) {
    super(message);
    this.name = "LockError";
  }
}

export interface LockHandle {
  path: string;
  release(): Promise<void>;
}

const MAX_LOCK_BYTES = 16 * 1024;

interface LockRecord {
  pid: number;
  nonce: string;
  timestamp: string;
}

interface LockObservation {
  state: "LIVE" | "STALE";
  record: LockRecord;
  identity: StableFileIdentity;
}

type LockInspection = { state: "MISSING" | "MALFORMED" } | LockObservation;

function parseOwnedLock(raw: string): LockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return null;
    if (typeof value.nonce !== "string" || value.nonce.length < 16 || value.nonce.length > 256) return null;
    if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) return null;
    return { pid: Number(value.pid), nonce: value.nonce, timestamp: value.timestamp };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function stableIdentity(stats: Stats): StableFileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function inspectLock(lockPath: string): Promise<LockInspection> {
  const info = await lstat(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { state: "MISSING" };
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_LOCK_BYTES) return { state: "MALFORMED" };
  try {
    const snapshot = await readStableFile(lockPath, MAX_LOCK_BYTES);
    const record = parseOwnedLock(snapshot.bytes.toString("utf8"));
    if (!record) return { state: "MALFORMED" };
    return { state: processIsAlive(record.pid) ? "LIVE" : "STALE", record, identity: snapshot.identity };
  } catch {
    const after = await lstat(lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    return after ? { state: "MALFORMED" } : { state: "MISSING" };
  }
}

async function reclaimDeadLock(lockPath: string, observed: LockObservation, code: LockCode): Promise<void> {
  if (observed.state !== "STALE" || processIsAlive(observed.record.pid)) throw new LockError(code, `Lock owner is not safely reclaimable: ${lockPath}`);
  const current = await lstat(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!current) return;
  if (current.isSymbolicLink() || !current.isFile() || !sameStableFileIdentity(stableIdentity(current), observed.identity)) throw new LockError(code, `Lock changed while stale recovery was being attested: ${lockPath}`);
  await unlink(lockPath);
}

async function installLock(parentPath: string, lockPath: string, bytes: Buffer, code: LockCode): Promise<StableFileIdentity | null> {
  const temporary = path.join(parentPath, `.${path.basename(lockPath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let linked = false;
  let temporaryPresent = true;
  let prepared: Stats | null = null;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    prepared = await handle.stat();
    if (!prepared.isFile() || prepared.size !== bytes.byteLength) throw new LockError(code, `Prepared lock is incomplete: ${lockPath}`);
    await handle.close();
    handle = null;
    try { await link(temporary, lockPath); linked = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    const linkedStat = await lstat(lockPath);
    if (linkedStat.isSymbolicLink() || !linkedStat.isFile() || !sameInode(prepared, linkedStat)) throw new LockError(code, `Lock changed while being atomically installed: ${lockPath}`);
    await unlink(temporary);
    temporaryPresent = false;
    const installed = await lstat(lockPath);
    if (installed.isSymbolicLink() || !installed.isFile() || !sameInode(prepared, installed)) throw new LockError(code, `Lock changed after atomic installation: ${lockPath}`);
    return stableIdentity(installed);
  } catch (error) {
    if (linked && prepared) {
      const current = await lstat(lockPath).catch(() => null);
      if (current && current.isFile() && !current.isSymbolicLink() && sameInode(prepared, current)) await unlink(lockPath).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryPresent) await unlink(temporary).catch(() => undefined);
  }
}

export async function acquireExclusiveLock(lockPath: string, code: LockCode): Promise<LockHandle> {
  const resolved = path.resolve(lockPath);
  const parentPath = path.dirname(resolved);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parent = await lstat(parentPath);
  if (parent.isSymbolicLink() || !parent.isDirectory() || await realpath(parentPath) !== parentPath) {
    throw new LockError(code, `Lock directory is unsafe: ${parentPath}`);
  }

  let guard;
  try {
    guard = await acquireTicketFileLock(path.join(parentPath, `.${path.basename(resolved)}.acquire`), { timeoutMs: 5_000, pollMs: 25 });
  } catch (error) {
    if (error instanceof TicketFileLockError) throw new LockError(code, `Lock acquisition could not be serialized safely: ${error.message}`);
    throw error;
  }

  const pid = process.pid;
  const nonce = randomUUID();
  const bytes = Buffer.from(`${JSON.stringify({ pid, nonce, timestamp: new Date().toISOString() } satisfies LockRecord)}\n`, "utf8");
  let installedIdentity: StableFileIdentity;
  try {
    const observed = await inspectLock(resolved);
    if (observed.state === "LIVE") throw new LockError(code, `Lock already exists and is owned by a live process: ${resolved}`);
    if (observed.state === "MALFORMED") throw new LockError(code, `Lock is malformed or unsafe; explicit operator recovery is required: ${resolved}`);
    if (observed.state === "STALE") await reclaimDeadLock(resolved, observed, code);
    const installed = await installLock(parentPath, resolved, bytes, code);
    if (!installed) throw new LockError(code, `Lock changed during serialized acquisition: ${resolved}`);
    installedIdentity = installed;
  } finally {
    await guard.release().catch(() => undefined);
  }

  let released = false;
  return {
    path: resolved,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const snapshot = await readStableFile(resolved, MAX_LOCK_BYTES);
        const current = parseOwnedLock(snapshot.bytes.toString("utf8"));
        if (current?.pid !== pid || current.nonce !== nonce || !sameStableFileIdentity(snapshot.identity, installedIdentity)) return;
        const beforeRemove = await lstat(resolved);
        if (beforeRemove.isSymbolicLink() || !beforeRemove.isFile() || !sameStableFileIdentity(stableIdentity(beforeRemove), installedIdentity)) return;
        await unlink(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
    },
  };
}

export function runLockPath(stateDirectory: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "locks", `run-${archiveSha256}.lock`);
}

export function watchLockPath(stateDirectory: string): string {
  return path.join(path.resolve(stateDirectory), "locks", "watch.lock");
}
