import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { InboxIndex } from "./contracts.js";
import { atomicWriteJson } from "../run/run-store.js";

export function inboxIndexPath(stateDirectory: string): string {
  return path.join(path.resolve(stateDirectory), "inbox-index.json");
}

export async function readInboxIndex(stateDirectory: string): Promise<InboxIndex> {
  try {
    const info = await lstat(inboxIndexPath(stateDirectory));
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Inbox index must be a regular non-symlink file.");
    const parsed = JSON.parse(await readFile(inboxIndexPath(stateDirectory), "utf8")) as Partial<InboxIndex>;
    if (parsed.index_version !== "1.0" || !parsed.entries || typeof parsed.entries !== "object") throw new Error("Invalid inbox index.");
    return parsed as InboxIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { index_version: "1.0", entries: {} };
    if (error instanceof SyntaxError || error instanceof Error) throw new Error(`Inbox index is invalid: ${error.message}`);
    throw error;
  }
}

export async function writeInboxIndex(stateDirectory: string, index: InboxIndex): Promise<void> {
  try {
    const info = await lstat(inboxIndexPath(stateDirectory));
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Inbox index must be a regular non-symlink file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteJson(inboxIndexPath(stateDirectory), index);
}
