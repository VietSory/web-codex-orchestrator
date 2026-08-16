import crypto from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, link, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { readStableFile, sameStableFileIdentity, type StableFileIdentity } from "./stable-file.js";

const MAX_LOCK_BYTES = 16 * 1024;
const TICKET_NAME = /^(\d{1,12})\.lock$/;

interface TicketBody {
  version: "1.0";
  pid: number;
  nonce: string;
  created_at: string;
}

interface TicketObservation {
  body: TicketBody;
  identity: StableFileIdentity;
}

export interface TicketFileLockHandle {
  ticketPath: string;
  sequence: number;
  release(): Promise<void>;
}

export class TicketFileLockError extends Error {
  constructor(public readonly code: "TICKET_LOCK_INVALID" | "TICKET_LOCKED", message: string) {
    super(message);
    this.name = "TicketFileLockError";
  }
}

function parseTicket(bytes: Buffer): TicketBody {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock record is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock record is invalid.");
  const item = value as Partial<TicketBody>;
  if (item.version !== "1.0" || !Number.isSafeInteger(item.pid) || (item.pid ?? 0) <= 0 || typeof item.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(item.nonce) || typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at))) {
    throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock record failed schema validation.");
  }
  return item as TicketBody;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function statsIdentity(stats: Stats): StableFileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

async function canonicalLockDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  const parentInfo = await lstat(parent).catch((error: unknown) => {
    throw new TicketFileLockError("TICKET_LOCK_INVALID", `Ticket lock parent is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock parent directory is unsafe.");
  }
  try { await mkdir(absolute, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock directory is unsafe.");
  if (await realpath(parent) !== parent) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock parent changed during directory creation.");
  return absolute;
}

async function ticketNames(directory: string): Promise<Array<{ name: string; sequence: number }>> {
  const names = await readdir(directory);
  if (names.length > 1_024) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock queue exceeds its safe bound.");
  const tickets: Array<{ name: string; sequence: number }> = [];
  for (const name of names) {
    const match = TICKET_NAME.exec(name);
    if (!match) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock directory contains an unexpected entry.");
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock sequence is invalid.");
    tickets.push({ name, sequence });
  }
  return tickets.sort((a, b) => a.sequence - b.sequence);
}

async function readTicketIfPresent(ticketPath: string): Promise<TicketObservation | null> {
  const before = await lstat(ticketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOCK_BYTES) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock path is unsafe or exceeds its bound.");
  try {
    const snapshot = await readStableFile(ticketPath, MAX_LOCK_BYTES);
    return { body: parseTicket(snapshot.bytes), identity: snapshot.identity };
  } catch (error) {
    if (error instanceof TicketFileLockError) throw error;
    const after = await lstat(ticketPath).catch((checkError: unknown) => {
      if ((checkError as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw checkError;
    });
    if (!after) return null;
    throw new TicketFileLockError("TICKET_LOCK_INVALID", `Ticket lock could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function unlinkObservedTicket(ticketPath: string, observed: TicketObservation): Promise<void> {
  const current = await lstat(ticketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!current) return;
  if (!current.isFile() || current.isSymbolicLink() || !sameStableFileIdentity(statsIdentity(current), observed.identity)) {
    throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock changed before safe removal.");
  }
  await unlink(ticketPath);
}

async function allocateTicket(directory: string): Promise<{ path: string; sequence: number; body: TicketBody; identity: StableFileIdentity }> {
  const nonce = crypto.randomUUID();
  const parent = path.dirname(directory);
  while (true) {
    const tickets = await ticketNames(directory);
    const sequence = (tickets.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence > 999_999_999_999) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock sequence exhausted its safe bound.");
    const ticketPath = path.join(directory, `${sequence}.lock`);
    const temporary = path.join(parent, `.${path.basename(directory)}.${process.pid}.${nonce}.${sequence}.ticket.tmp`);
    const body: TicketBody = { version: "1.0", pid: process.pid, nonce, created_at: new Date().toISOString() };
    const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    if (bytes.byteLength > MAX_LOCK_BYTES) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock record exceeds its safe bound.");
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let linked = false;
    let temporaryPresent = true;
    let prepared: Stats | null = null;
    try {
      handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      prepared = await handle.stat();
      if (!prepared.isFile() || prepared.size !== bytes.byteLength) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Prepared ticket lock is incomplete.");
      await handle.close();
      handle = null;
      try { await link(temporary, ticketPath); linked = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const linkedStat = await lstat(ticketPath);
      if (linkedStat.isSymbolicLink() || !linkedStat.isFile() || !sameInode(prepared, linkedStat)) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock changed while being atomically installed.");
      await unlink(temporary);
      temporaryPresent = false;
      const observed = await readTicketIfPresent(ticketPath);
      if (!observed || observed.body.pid !== body.pid || observed.body.nonce !== body.nonce) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock changed during allocation.");
      return { path: ticketPath, sequence, body, identity: observed.identity };
    } catch (error) {
      if (linked && prepared) {
        const current = await lstat(ticketPath).catch(() => null);
        if (current && current.isFile() && !current.isSymbolicLink() && sameInode(prepared, current)) await unlink(ticketPath).catch(() => undefined);
      }
      if (error instanceof TicketFileLockError) throw error;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      if (temporaryPresent) await unlink(temporary).catch(() => undefined);
    }
  }
}

export async function acquireTicketFileLock(directory: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<TicketFileLockHandle> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock timeout/poll bounds are invalid.");
  const root = await canonicalLockDirectory(directory);
  const own = await allocateTicket(root);
  const started = Date.now();
  let released = false;

  const release = async (): Promise<void> => {
    if (released) return;
    const current = await readTicketIfPresent(own.path);
    if (!current) { released = true; return; }
    if (current.body.pid !== own.body.pid || current.body.nonce !== own.body.nonce || !sameStableFileIdentity(current.identity, own.identity)) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock ownership changed before release.");
    await unlinkObservedTicket(own.path, current);
    released = true;
  };

  try {
    while (true) {
      let blockedByLiveOlder = false;
      const tickets = await ticketNames(root);
      for (const ticket of tickets) {
        if (ticket.sequence >= own.sequence) break;
        const ticketPath = path.join(root, ticket.name);
        const observed = await readTicketIfPresent(ticketPath);
        if (!observed) continue;
        if (processIsAlive(observed.body.pid)) { blockedByLiveOlder = true; break; }
        await unlinkObservedTicket(ticketPath, observed);
      }
      if (!blockedByLiveOlder) return { ticketPath: own.path, sequence: own.sequence, release };
      if (Date.now() - started >= timeoutMs) throw new TicketFileLockError("TICKET_LOCKED", `Ticket lock remained busy for ${timeoutMs}ms.`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}
