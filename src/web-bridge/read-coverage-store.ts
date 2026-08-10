import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { WebBridgeError } from "./contracts.js";

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

async function canonicalDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new WebBridgeError("WEB_READ_RECEIPT_ROOT_UNSAFE", "Read receipt root is not a canonical directory.");
  return absolute;
}

export class ReadCoverageStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly maximumReceipts = 10_000) {}
  async append(receipt: ReadCoverageReceipt): Promise<void> {
    const task = this.pending.then(async () => {
      const root = await canonicalDirectory(this.root);
      const target = path.join(root, `${receipt.job_id}.json`);
      let receipts: ReadCoverageReceipt[] = [];
      try { receipts = JSON.parse(await readFile(target, "utf8")) as ReadCoverageReceipt[]; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const key = `${receipt.request_id}\0${receipt.path}\0${receipt.start_byte}\0${receipt.end_byte_exclusive}`;
      const existing = receipts.find((item) => `${item.request_id}\0${item.path}\0${item.start_byte}\0${item.end_byte_exclusive}` === key);
      if (existing) {
        if (crypto.createHash("sha256").update(canonicalJsonBuffer(existing)).digest("hex") !== crypto.createHash("sha256").update(canonicalJsonBuffer(receipt)).digest("hex")) throw new WebBridgeError("WEB_READ_RECEIPT_REPLAY_CONFLICT", "Conflicting read receipt replay was rejected.");
        return;
      }
      if (receipts.length >= this.maximumReceipts) throw new WebBridgeError("WEB_READ_RECEIPT_LIMIT", "Read receipt limit reached for this job.");
      receipts.push(receipt);
      receipts.sort((a, b) => a.request_id.localeCompare(b.request_id) || a.path.localeCompare(b.path) || a.start_byte - b.start_byte);
      const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(canonicalJsonBuffer(receipts)); await handle.sync(); } finally { await handle.close(); }
      try { await rename(temp, target); } finally { await unlink(temp).catch(() => undefined); }
    });
    this.pending = task.catch(() => undefined);
    return await task;
  }
  async list(jobId: string): Promise<ReadCoverageReceipt[]> {
    const root = await canonicalDirectory(this.root);
    try { const value = JSON.parse(await readFile(path.join(root, `${jobId}.json`), "utf8")) as unknown; if (!Array.isArray(value)) throw new Error("not array"); return value as ReadCoverageReceipt[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new WebBridgeError("WEB_READ_RECEIPT_INVALID", "Read receipt store is invalid."); }
  }
}
