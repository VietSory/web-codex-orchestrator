import path from "node:path";
import { ensureCanonicalDirectory } from "../shared/safe-directory.js";
import { acquireTicketFileLock, TicketFileLockError } from "../shared/ticket-file-lock.js";
import { WebBridgeError } from "./contracts.js";

const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function withSessionFocusLock<T>(
  stateDirectory: string,
  repositoryId: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!SAFE_REPOSITORY_ID.test(repositoryId)) throw new WebBridgeError("WEB_SESSION_ID_INVALID", "Repository identity is invalid.");
  const stateRoot = path.resolve(stateDirectory);
  const locksRoot = await ensureCanonicalDirectory(path.join(stateRoot, "bridge", "sessions", ".focus-locks"), "WCO session focus locks");
  let lock;
  try {
    lock = await acquireTicketFileLock(path.join(locksRoot, repositoryId), { timeoutMs: 10_000, pollMs: 25 });
  } catch (error) {
    if (error instanceof TicketFileLockError) throw new WebBridgeError(error.code === "TICKET_LOCKED" ? "WEB_SESSION_LOCKED" : "WEB_SESSION_LOCK_INVALID", error.message);
    throw error;
  }
  try { return await action(); }
  finally { await lock.release(); }
}
