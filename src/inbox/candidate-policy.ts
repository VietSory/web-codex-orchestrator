import { lstat } from "node:fs/promises";
import path from "node:path";
import { INBOX_CANDIDATE_PATTERN } from "./constants.js";

export type CandidatePolicyCode = "INBOX_NOT_FOUND" | "INBOX_NOT_DIRECTORY" | "INBOX_SYMLINK" | "INBOX_LIMIT_EXCEEDED";

export class CandidatePolicyError extends Error {
  constructor(readonly code: CandidatePolicyCode, message: string) {
    super(message);
    this.name = "CandidatePolicyError";
  }
}

export async function assertInboxDirectory(inboxDirectory: string): Promise<string> {
  const resolved = path.resolve(inboxDirectory);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CandidatePolicyError("INBOX_NOT_FOUND", `Inbox does not exist: ${resolved}`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new CandidatePolicyError("INBOX_SYMLINK", "Inbox must not be a symbolic link.");
  if (!info.isDirectory()) throw new CandidatePolicyError("INBOX_NOT_DIRECTORY", "Inbox must be a directory.");
  return resolved;
}

export function isCandidateFilename(name: string): boolean {
  return !name.startsWith(".") && INBOX_CANDIDATE_PATTERN.test(name) && !name.endsWith(".crdownload") && !name.endsWith(".part") && !name.endsWith(".tmp");
}
