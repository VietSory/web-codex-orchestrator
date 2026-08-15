import { lstat } from "node:fs/promises";
import path from "node:path";
import type { InboxIndex, InboxIndexEntry } from "./contracts.js";
import { atomicWriteText } from "../run/run-store.js";
import { readStableFile } from "../shared/stable-file.js";

const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_ACTIVE_INDEX_ENTRIES = 10_000;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RESULTS = new Set<InboxIndexEntry["latest_result"]>(["ready_for_codex", "rejected", "blocked", "failed"]);

export function inboxIndexPath(stateDirectory: string): string {
  return path.join(path.resolve(stateDirectory), "inbox-index.json");
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && !value.includes("\0") && path.isAbsolute(value);
}

function validEntry(key: string, value: unknown): value is InboxIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<InboxIndexEntry>;
  return safePath(key)
    && item.canonical_source_path === key
    && Number.isSafeInteger(item.size) && Number(item.size) >= 0
    && typeof item.mtime_ms === "number" && Number.isFinite(item.mtime_ms) && item.mtime_ms >= 0
    && RESULTS.has(item.latest_result as InboxIndexEntry["latest_result"])
    && typeof item.last_processed_time === "string" && Number.isFinite(Date.parse(item.last_processed_time))
    && (item.archive_sha256 === undefined || typeof item.archive_sha256 === "string" && SHA256.test(item.archive_sha256))
    && (item.latest_run_id === undefined || typeof item.latest_run_id === "string" && SAFE_RUN_ID.test(item.latest_run_id));
}

function parseIndex(bytes: Buffer): InboxIndex {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch (error) { throw new Error(`Inbox index is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Inbox index must be an object.");
  const value = parsed as Partial<InboxIndex>;
  if (value.index_version !== "1.0" || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) throw new Error("Inbox index failed top-level validation.");
  // Legacy indexes may contain more than the current active-candidate bound.
  // The 64 MiB stable-read ceiling keeps migration resource-bounded; scanner
  // compaction removes entries for files no longer present before the next write.
  for (const [key, entry] of Object.entries(value.entries)) if (!validEntry(key, entry)) throw new Error(`Inbox index entry is invalid: ${key.slice(0, 256)}`);
  return value as InboxIndex;
}

export async function readInboxIndex(stateDirectory: string): Promise<InboxIndex> {
  const target = inboxIndexPath(stateDirectory);
  const info = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { index_version: "1.0", entries: {} };
  try {
    return parseIndex((await readStableFile(target, MAX_INDEX_BYTES)).bytes);
  } catch (error) {
    throw new Error(`Inbox index is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeInboxIndex(stateDirectory: string, index: InboxIndex): Promise<void> {
  const entries = Object.entries(index.entries);
  if (index.index_version !== "1.0" || entries.length > MAX_ACTIVE_INDEX_ENTRIES) throw new Error(`Inbox index exceeds its ${MAX_ACTIVE_INDEX_ENTRIES}-entry active bound.`);
  for (const [key, entry] of entries) if (!validEntry(key, entry)) throw new Error(`Inbox index entry is invalid: ${key.slice(0, 256)}`);
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  const encodedBytes = Buffer.byteLength(serialized, "utf8");
  if (encodedBytes > MAX_INDEX_BYTES) throw new Error(`Inbox index exceeds ${MAX_INDEX_BYTES} bytes.`);
  try {
    const info = await lstat(inboxIndexPath(stateDirectory));
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Inbox index must be a regular non-symlink file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteText(inboxIndexPath(stateDirectory), serialized);
}
