import crypto from "node:crypto";
import { chmod, lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { ensureCanonicalDirectory } from "../shared/safe-directory.js";
import { readStableFile } from "../shared/stable-file.js";
import { WebBridgeError } from "./contracts.js";

interface CacheRecord {
  schema_version: "1.0";
  key_sha256: string;
  content_sha256: string;
  content_base64: string;
}

function digest(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function safeDirectory(root: string): Promise<string> {
  const absolute = await ensureCanonicalDirectory(root, "Web context cache");
  await chmod(absolute, 0o700).catch(() => undefined);
  return absolute;
}

/**
 * Disposable content-addressed performance state. Cache records never replace
 * exact Git binding checks, read receipts, preimages, or canonical evidence.
 */
export class ContentAddressedContextCache {
  constructor(
    private readonly root: string,
    private readonly maximumEntryBytes = 1_048_576,
    private readonly maximumEntries = 128,
  ) {
    if (!Number.isSafeInteger(maximumEntryBytes) || maximumEntryBytes < 1 || maximumEntryBytes > 16 * 1024 * 1024) throw new WebBridgeError("WEB_CONTEXT_CACHE_LIMIT_INVALID", "Context cache entry byte bound is invalid.");
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 4_096) throw new WebBridgeError("WEB_CONTEXT_CACHE_LIMIT_INVALID", "Context cache entry-count bound is invalid.");
  }

  private async target(key: string): Promise<string> {
    return path.join(await safeDirectory(this.root), `${digest(key)}.json`);
  }

  private maximumRecordBytes(): number {
    return Math.ceil(this.maximumEntryBytes * 1.4) + 1024;
  }

  private async pruneForInsert(root: string): Promise<void> {
    const names = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length < this.maximumEntries) return;
    const entries: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of names) {
      const target = path.join(root, name);
      const info = await lstat(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!info) continue;
      // Cache files are disposable. A digest-named symlink or non-regular entry
      // is removed rather than allowed to pin cache capacity indefinitely.
      if (!info.isFile() || info.isSymbolicLink()) {
        await unlink(target).catch(() => undefined);
        continue;
      }
      entries.push({ name, mtimeMs: info.mtimeMs });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    const removeCount = Math.max(0, entries.length - this.maximumEntries + 1);
    for (const entry of entries.slice(0, removeCount)) await unlink(path.join(root, entry.name)).catch(() => undefined);
  }

  async evict(key: string): Promise<void> {
    const target = await this.target(key);
    const info = await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) {
      throw new WebBridgeError("WEB_CONTEXT_CACHE_ENTRY_INVALID", "Context cache eviction target is not a canonical regular file.");
    }
    await unlink(target);
  }

  async get(key: string): Promise<Buffer | null> {
    const root = await safeDirectory(this.root);
    const keySha = digest(key);
    const target = path.join(root, `${keySha}.json`);
    const initial = await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!initial) return null;
    try {
      if (!initial.isFile() || initial.isSymbolicLink() || initial.size > this.maximumRecordBytes() || await realpath(target) !== target) {
        throw new WebBridgeError("WEB_CONTEXT_CACHE_ENTRY_INVALID", "Context cache entry is unsafe or exceeds its bound.");
      }
      const { bytes } = await readStableFile(target, this.maximumRecordBytes());
      const parsed = JSON.parse(bytes.toString("utf8")) as Partial<CacheRecord>;
      if (parsed.schema_version !== "1.0" || parsed.key_sha256 !== keySha || typeof parsed.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.content_sha256) || typeof parsed.content_base64 !== "string") {
        throw new WebBridgeError("WEB_CONTEXT_CACHE_ENTRY_INVALID", "Context cache entry failed schema validation.");
      }
      const content = Buffer.from(parsed.content_base64, "base64");
      if (content.byteLength > this.maximumEntryBytes || content.toString("base64") !== parsed.content_base64 || digest(content) !== parsed.content_sha256) {
        throw new WebBridgeError("WEB_CONTEXT_CACHE_ENTRY_INVALID", "Context cache entry failed content validation.");
      }
      return content;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof WebBridgeError && error.code === "WEB_CONTEXT_CACHE_ENTRY_INVALID" || error instanceof Error && error.name === "StableFileError") {
        // Cache bytes are disposable and never authority. Remove only the exact
        // digest-named entry; the caller must rebuild from canonical Git/evidence.
        await unlink(target).catch(() => undefined);
        return null;
      }
      throw error;
    }
  }

  async put(key: string, content: Buffer): Promise<void> {
    if (content.byteLength > this.maximumEntryBytes) return;
    const root = await safeDirectory(this.root);
    const keySha = digest(key);
    const target = path.join(root, `${keySha}.json`);
    const record: CacheRecord = { schema_version: "1.0", key_sha256: keySha, content_sha256: digest(content), content_base64: content.toString("base64") };
    const bytes = canonicalJsonBuffer(record);
    const existing = await this.get(key);
    if (existing) {
      if (!existing.equals(content)) throw new WebBridgeError("WEB_CONTEXT_CACHE_REPLAY_CONFLICT", "Context cache key resolved to different content.");
      return;
    }
    await this.pruneForInsert(root);
    const temporary = path.join(root, `.${keySha}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, target); await chmod(target, 0o600).catch(() => undefined); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
}

export interface ContextTransferMetrics {
  context_bytes_prepared: number;
  context_bytes_transmitted: number;
  repeated_bytes_avoided: number;
  files_considered: number;
  files_read: number;
  regions_read: number;
  cache_hits: number;
  cache_misses: number;
}

export function emptyContextTransferMetrics(): ContextTransferMetrics {
  return { context_bytes_prepared: 0, context_bytes_transmitted: 0, repeated_bytes_avoided: 0, files_considered: 0, files_read: 0, regions_read: 0, cache_hits: 0, cache_misses: 0 };
}
