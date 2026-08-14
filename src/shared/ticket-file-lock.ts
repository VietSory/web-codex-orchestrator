import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { readStableFile } from "./stable-file.js";

const MAX_LOCK_BYTES = 16 * 1024;
const TICKET_NAME = /^(\d{1,12})\.lock$/;

interface TicketBody {
  version: "1.0";
  pid: number;
  nonce: string;
  created_at: string;
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

async function canonicalLockDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock directory is unsafe.");
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

async function readTicketIfPresent(ticketPath: string): Promise<TicketBody | null> {
  const before = await lstat(ticketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOCK_BYTES) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock path is unsafe or exceeds its bound.");
  try { return parseTicket((await readStableFile(ticketPath, MAX_LOCK_BYTES)).bytes); }
  catch (error) {
    if (error instanceof TicketFileLockError) throw error;
    // A legitimate owner may release after readdir/lstat but before or during
    // stable open. Treat only a now-missing path as a normal queue race.
    const after = await lstat(ticketPath).catch((checkError: unknown) => {
      if ((checkError as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw checkError;
    });
    if (!after) return null;
    throw new TicketFileLockError("TICKET_LOCK_INVALID", `Ticket lock could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function allocateTicket(directory: string): Promise<{ path: string; sequence: number; body: TicketBody }> {
  const nonce = crypto.randomUUID();
  while (true) {
    const tickets = await ticketNames(directory);
    const sequence = (tickets.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence > 999_999_999_999) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock sequence exhausted its safe bound.");
    const ticketPath = path.join(directory, `${sequence}.lock`);
    const body: TicketBody = { version: "1.0", pid: process.pid, nonce, created_at: new Date().toISOString() };
    let handle;
    try {
      handle = await open(ticketPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(`${JSON.stringify(body)}\n`, "utf8");
      // Ticket files coordinate live processes only; they intentionally do not
      // need crash-persistent fsync durability. The durable relay record still
      // fsyncs separately before authority can advance.
      await handle.close();
      const observed = await readTicketIfPresent(ticketPath);
      if (!observed || observed.pid !== body.pid || observed.nonce !== body.nonce) throw new TicketFileLockError("TICKET_LOCK_INVALID", "Ticket lock changed during allocation.");
      return { path: ticketPath, sequence, body };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      if (error instanceof TicketFileLockError) await unlink(ticketPath).catch(() => undefined);
      throw error;
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
    released = true;
    const current = await readTicketIfPresent(own.path);
    if (current && current.pid === own.body.pid && current.nonce === own.body.nonce) await unlink(own.path);
  };

  try {
    while (true) {
      let blockedByLiveOlder = false;
      const tickets = await ticketNames(root);
      for (const ticket of tickets) {
        if (ticket.sequence >= own.sequence) break;
        const ticketPath = path.join(root, ticket.name);
        const body = await readTicketIfPresent(ticketPath);
        if (!body) continue;
        if (processIsAlive(body.pid)) { blockedByLiveOlder = true; break; }
        // The filename cannot be reused while our higher sequence ticket exists,
        // so deleting this exact dead predecessor cannot unlink a new owner.
        await unlink(ticketPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      }
      if (!blockedByLiveOlder) return { ticketPath: own.path, sequence: own.sequence, release };
      if (Date.now() - started >= timeoutMs) throw new TicketFileLockError("TICKET_LOCKED", `Ticket lock remained busy for ${timeoutMs}ms.`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    await release();
    throw error;
  }
}
