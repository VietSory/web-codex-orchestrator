import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { InboxIndex, InboxIndexEntry } from "./contracts.js";
import { atomicWriteJson } from "../run/run-store.js";

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 4096;
const SHA256 = /^[a-f0-9]{64}$/;

export function inboxIndexPath(stateDirectory: string): string {
  return path.join(path.resolve(stateDirectory), "inbox-index.json");
}

function validEntry(value: unknown): value is InboxIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.canonical_source_path === "string" && entry.canonical_source_path.length > 0 && entry.canonical_source_path.length <= 8192 && path.isAbsolute(entry.canonical_source_path) &&
    Number.isSafeInteger(entry.size) && Number(entry.size) >= 0 &&
    typeof entry.mtime_ms === "number" && Number.isFinite(entry.mtime_ms) && entry.mtime_ms >= 0 &&
    (entry.archive_sha256 === undefined || typeof entry.archive_sha256 === "string" && SHA256.test(entry.archive_sha256)) &&
    (entry.latest_run_id === undefined || typeof entry.latest_run_id === "string" && entry.latest_run_id.length > 0 && entry.latest_run_id.length <= 512) &&
    ["ready_for_codex", "rejected", "blocked", "failed"].includes(String(entry.latest_result)) &&
    typeof entry.last_processed_time === "string" && Number.isFinite(Date.parse(entry.last_processed_time))
  );
}

function assertIndex(value: unknown): asserts value is InboxIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inbox index must be an object.");
  const index = value as Record<string, unknown>;
  if (index.index_version !== "1.0" || !index.entries || typeof index.entries !== "object" || Array.isArray(index.entries)) throw new Error("Invalid inbox index.");
  const entries = Object.entries(index.entries as Record<string, unknown>);
  if (entries.length > MAX_INDEX_ENTRIES) throw new Error(`Inbox index exceeds ${MAX_INDEX_ENTRIES} entries.`);
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > 8192 || !validEntry(entry)) throw new Error("Inbox index contains an invalid entry.");
  }
}

async function readStableIndex(filePath: string): Promise<Buffer | null> {
  let pathBefore: Stats;
  try { pathBefore = await lstat(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > MAX_INDEX_BYTES) throw new Error("Inbox index must be a bounded regular non-symlink file.");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > MAX_INDEX_BYTES) throw new Error("Inbox index changed before open.");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("Inbox index was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new Error("Inbox index grew while reading.");
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) throw new Error("Inbox index changed while reading.");
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readInboxIndex(stateDirectory: string): Promise<InboxIndex> {
  try {
    const bytes = await readStableIndex(inboxIndexPath(stateDirectory));
    if (bytes === null) return { index_version: "1.0", entries: {} };
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    assertIndex(parsed);
    return parsed;
  } catch (error) {
    throw new Error(`Inbox index is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeInboxIndex(stateDirectory: string, index: InboxIndex): Promise<void> {
  assertIndex(index);
  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_INDEX_BYTES) throw new Error(`Inbox index exceeds ${MAX_INDEX_BYTES} bytes.`);
  const target = inboxIndexPath(stateDirectory);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Inbox index must be a regular non-symlink file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteJson(target, index);
}
