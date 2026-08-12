import crypto from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
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
  const absolute = path.resolve(root);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new WebBridgeError("WEB_CONTEXT_CACHE_ROOT_UNSAFE", "Context cache root is not a canonical directory.");
  }
  await chmod(absolute, 0o700).catch(() => undefined);
  return absolute;
}

/**
 * Disposable content-addressed performance state. Cache records never replace
 * exact Git binding checks, read receipts, preimages, or canonical evidence.
 */
export class ContentAddressedContextCache {
  constructor(private readonly root: string, private readonly maximumEntryBytes = 1_048_576) {}

  async get(key: string): Promise<Buffer | null> {
    const root = await safeDirectory(this.root);
    const keySha = digest(key);
    const target = path.join(root, `${keySha}.json`);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > Math.ceil(this.maximumEntryBytes * 1.4) + 1024 || await realpath(target) !== target) {
        throw new WebBridgeError("WEB_CONTEXT_CACHE_ENTRY_INVALID", "Context cache entry is unsafe or exceeds its bound.");
      }
      const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<CacheRecord>;
      if (parsed.schema_version !== "1.0" || parsed.key_sha256 !== keySha || typeof parsed.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.content_sha256) || typeof parsed.content_base64 !== "string") {
        throw new WebBridgeError("WEB_CONTEXT_CACHE_ENTRY_INVALID", "Context cache entry failed schema validation.");
      }
      const content = Buffer.from(parsed.content_base64, "base64");
      if (content.byteLength > this.maximumEntryBytes || content.toString("base64") !== parsed.content_base64 || digest(content) !== parsed.content_sha256) {
        throw new WebBridgeError("WEB_CONTEXT_CACHE_ENTRY_INVALID", "Context cache entry failed content validation.");
      }
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof WebBridgeError && error.code === "WEB_CONTEXT_CACHE_ENTRY_INVALID") {
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
