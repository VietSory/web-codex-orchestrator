import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { assertRepositoryRelativePath } from "../web-authority/pack-reader.js";
import { WebBridgeError } from "./contracts.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GIT_OID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const MAX_READ_BYTES = 8_388_608;

export interface ReadCoverageReceipt {
  schema_version: "1.0";
  job_id: string;
  request_id: string;
  base_commit: string;
  path: string;
  blob_sha: string;
  content_sha256: string;
  start_byte: number;
  end_byte_exclusive: number;
  total_bytes: number;
  observed_at: string;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function validateReceipt(value: unknown, expectedJobId?: string): ReadCoverageReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt must be an object.");
  const receipt = value as Record<string, unknown>;
  const allowed = ["schema_version", "job_id", "request_id", "base_commit", "path", "blob_sha", "content_sha256", "start_byte", "end_byte_exclusive", "total_bytes", "observed_at"];
  if (Object.keys(receipt).some((key) => !allowed.includes(key)) || receipt.schema_version !== "1.0") throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt schema is invalid.");
  if (typeof receipt.job_id !== "string" || !SAFE_ID.test(receipt.job_id) || expectedJobId !== undefined && receipt.job_id !== expectedJobId) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt job identity is invalid.");
  if (typeof receipt.request_id !== "string" || !SAFE_ID.test(receipt.request_id)) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt request identity is invalid.");
  if (typeof receipt.base_commit !== "string" || !GIT_OID.test(receipt.base_commit) || typeof receipt.blob_sha !== "string" || !GIT_OID.test(receipt.blob_sha) || typeof receipt.content_sha256 !== "string" || !SHA256.test(receipt.content_sha256)) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt digest binding is invalid.");
  if (typeof receipt.path !== "string" || Buffer.byteLength(receipt.path, "utf8") > MAX_PATH_BYTES) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt path is invalid.");
  try { assertRepositoryRelativePath(receipt.path); } catch { throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt path is not repository-relative."); }
  if (!Number.isSafeInteger(receipt.start_byte) || !Number.isSafeInteger(receipt.end_byte_exclusive) || !Number.isSafeInteger(receipt.total_bytes)) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt byte range is inconsistent.");
  const startByte = receipt.start_byte as number;
  const endByte = receipt.end_byte_exclusive as number;
  const totalBytes = receipt.total_bytes as number;
  const emptyExactRead = totalBytes === 0 && startByte === 0 && endByte === 0;
  if (startByte < 0 || totalBytes < 0 || totalBytes > MAX_READ_BYTES || (!emptyExactRead && endByte <= startByte) || endByte > totalBytes || (totalBytes === 0 && !emptyExactRead)) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt byte range is inconsistent.");
  if (typeof receipt.observed_at !== "string" || !Number.isFinite(Date.parse(receipt.observed_at))) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt timestamp is invalid.");
  return receipt as unknown as ReadCoverageReceipt;
}

async function canonicalDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new WebBridgeError("WEB_READ_RECEIPT_ROOT_UNSAFE", "Read receipt root is not a canonical directory.");
  await chmod(absolute, 0o700).catch(() => undefined);
  return absolute;
}

async function stableRead(target: string, maximumBytes: number): Promise<Buffer | null> {
  const pathStat = await lstat(target).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (!pathStat) return null;
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > maximumBytes || await realpath(target) !== target) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store path is unsafe or exceeds its bound.");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(target, fsConstants.O_RDONLY | noFollow).catch((error) => { throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", `Read receipt store could not be opened safely: ${error instanceof Error ? error.message : String(error)}`); });
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(pathStat, before) || before.size > maximumBytes) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store changed before stable open.");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (bytesRead === 0) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store truncated during read."); offset += bytesRead; }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store grew during read.");
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(target)]);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameIdentity(before, afterHandle) || !sameIdentity(before, afterPath)) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store changed during read.");
    return bytes;
  } finally { await handle.close(); }
}

export class ReadCoverageStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly maximumReceipts = 10_000) {
    if (!Number.isSafeInteger(maximumReceipts) || maximumReceipts < 1 || maximumReceipts > 100_000) throw new WebBridgeError("WEB_READ_RECEIPT_LIMIT", "Read receipt count bound is invalid.");
  }

  private async read(jobId: string): Promise<ReadCoverageReceipt[]> {
    if (!SAFE_ID.test(jobId)) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt job identity is invalid.");
    const root = await canonicalDirectory(this.root);
    const bytes = await stableRead(path.join(root, `${jobId}.json`), MAX_STORE_BYTES);
    if (!bytes) return [];
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")) as unknown; } catch { throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store is not valid JSON."); }
    if (!Array.isArray(value) || value.length > this.maximumReceipts) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store is not a bounded array.");
    const receipts = value.map((item) => validateReceipt(item, jobId));
    const keys = new Set<string>();
    for (const receipt of receipts) {
      const key = `${receipt.request_id}\0${receipt.path}\0${receipt.start_byte}\0${receipt.end_byte_exclusive}`;
      if (keys.has(key)) throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store contains duplicate identities.");
      keys.add(key);
    }
    return receipts;
  }

  async append(receipt: ReadCoverageReceipt): Promise<void> {
    const validated = validateReceipt(receipt);
    const task = this.pending.then(async () => {
      const root = await canonicalDirectory(this.root);
      const target = path.join(root, `${validated.job_id}.json`);
      const receipts = await this.read(validated.job_id);
      const key = `${validated.request_id}\0${validated.path}\0${validated.start_byte}\0${validated.end_byte_exclusive}`;
      const existing = receipts.find((item) => `${item.request_id}\0${item.path}\0${item.start_byte}\0${item.end_byte_exclusive}` === key);
      if (existing) {
        if (crypto.createHash("sha256").update(canonicalJsonBuffer(existing)).digest("hex") !== crypto.createHash("sha256").update(canonicalJsonBuffer(validated)).digest("hex")) throw new WebBridgeError("WEB_READ_RECEIPT_REPLAY_CONFLICT", "Conflicting read receipt replay was rejected.");
        return;
      }
      if (receipts.length >= this.maximumReceipts) throw new WebBridgeError("WEB_READ_RECEIPT_LIMIT", "Read receipt limit reached for this job.");
      receipts.push(validated);
      receipts.sort((a, b) => a.request_id.localeCompare(b.request_id) || a.path.localeCompare(b.path) || a.start_byte - b.start_byte || a.end_byte_exclusive - b.end_byte_exclusive);
      const bytes = canonicalJsonBuffer(receipts);
      if (bytes.byteLength > MAX_STORE_BYTES) throw new WebBridgeError("WEB_READ_RECEIPT_LIMIT", "Read receipt store exceeds its byte bound.");
      const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try {
        await rename(temp, target);
        await chmod(target, 0o600).catch(() => undefined);
        const parent = await open(root, fsConstants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
      } finally { await unlink(temp).catch(() => undefined); }
    });
    this.pending = task.catch(() => undefined);
    return await task;
  }

  async list(jobId: string): Promise<ReadCoverageReceipt[]> {
    return await this.read(jobId);
  }
}
