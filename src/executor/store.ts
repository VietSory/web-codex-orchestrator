import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { ExecutorError, type ExecutorReceipt } from "./contracts.js";
import { executorPaths, prepareExecutorDirectory } from "./paths.js";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_ERRORS = 32;
const MAX_DIAGNOSTIC_CHARS = 8192;

function validateReceipt(receipt: ExecutorReceipt): void {
  if (receipt.executor_version !== "1.0" || receipt.run_id !== `${receipt.task_id}:${receipt.task_bundle_sha256}` || !/^[a-f0-9]{64}$/.test(receipt.task_bundle_sha256) || !/^[a-f0-9]{64}$/.test(receipt.artifact_sha256)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt identity is invalid.");
  if (!Array.isArray(receipt.operations) || receipt.operations.length > 256 || !Array.isArray(receipt.errors) || receipt.errors.length > MAX_ERRORS) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt arrays exceed their bounds.");
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const operation of receipt.operations) {
    if (!operation.op_id || ids.has(operation.op_id) || !operation.path || paths.has(operation.path) || !["create_file", "replace_file", "delete_file"].includes(operation.kind)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor operation identity is invalid/duplicated.");
    ids.add(operation.op_id); paths.add(operation.path);
  }
  for (const error of receipt.errors) if (error.code.length > 128 || error.message.length > MAX_DIAGNOSTIC_CHARS || !Number.isFinite(Date.parse(error.at))) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor diagnostic is invalid or oversized.");
}

async function readBounded(pathname: string): Promise<Buffer> {
  const handle = await fs.open(pathname, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_RECEIPT_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt is oversized or not a regular file.");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt grew while reading.");
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt changed while reading.");
    return bytes;
  } finally { await handle.close(); }
}

export async function readExecutorReceipt(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): Promise<ExecutorReceipt | null> {
  const paths = executorPaths(stateDirectory, taskId, taskBundleSha256, artifactSha256);
  let stat;
  try { stat = await fs.lstat(paths.receipt); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt must be a regular non-symlink file.");
  const bytes = await readBounded(paths.receipt);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt must be an object.");
  const receipt = parsed as ExecutorReceipt;
  validateReceipt(receipt);
  return receipt;
}

export async function writeExecutorReceipt(stateDirectory: string, receipt: ExecutorReceipt): Promise<void> {
  validateReceipt(receipt);
  const paths = executorPaths(stateDirectory, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256);
  await prepareExecutorDirectory(stateDirectory, paths.directory);
  const bytes = canonicalJsonBuffer(receipt);
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt exceeds byte cap.");
  const temp = path.join(paths.directory, `.executor-receipt.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
  try {
    const existing = await fs.lstat(paths.receipt).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt path is a symlink.");
    await fs.rename(temp, paths.receipt);
  } finally { await fs.unlink(temp).catch(() => undefined); }
}

export interface ExecutorLock { nonce: string; path: string; }

export async function acquireExecutorLock(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): Promise<ExecutorLock> {
  const paths = executorPaths(stateDirectory, taskId, taskBundleSha256, artifactSha256);
  await prepareExecutorDirectory(stateDirectory, paths.directory);
  const nonce = crypto.randomBytes(24).toString("hex");
  try {
    await fs.writeFile(paths.lock, canonicalJsonBuffer({ pid: process.pid, nonce, created_at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ExecutorError("EXECUTOR_LOCKED", "Executor artifact is already locked; stale locks are never auto-stolen.");
    throw error;
  }
  return { nonce, path: paths.lock };
}

export async function releaseExecutorLock(lock: ExecutorLock): Promise<void> {
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(lock.path, "utf8")); }
  catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { nonce?: unknown }).nonce !== lock.nonce) return;
  await fs.unlink(lock.path).catch(() => undefined);
}
