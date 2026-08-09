import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  GitPublishError,
  type GitPublishReceipt,
} from "./contracts.js";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PUBLISH_RECEIPT_BYTES = 16 * 1024 * 1024;

export interface GitPublishReceiptSnapshot {
  receipt: GitPublishReceipt;
  bytes: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableGitObjectId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && GIT_OBJECT_ID.test(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function assertReceipt(value: unknown): asserts value is GitPublishReceipt {
  if (!isRecord(value)) {
    throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt must be an object.");
  }

  const state = value.state;
  const expectedPaths = value.expected_paths;
  if (
    value.publish_version !== "1.1" ||
    typeof value.run_id !== "string" || value.run_id.length === 0 || value.run_id.length > 512 ||
    (state !== "READY_FOR_COMMIT" && state !== "COMMITTED" && state !== "PUSHED") ||
    typeof value.base_commit !== "string" || !GIT_OBJECT_ID.test(value.base_commit) ||
    typeof value.branch_name !== "string" || value.branch_name.length === 0 ||
    typeof value.remote_name !== "string" || value.remote_name.length === 0 ||
    typeof value.allowed_remote_url !== "string" || value.allowed_remote_url.length === 0 ||
    typeof value.change_set_sha256 !== "string" || !SHA256.test(value.change_set_sha256) ||
    !Array.isArray(expectedPaths) || expectedPaths.length === 0 || expectedPaths.length > 2_000 ||
    !expectedPaths.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 4_096 && !entry.includes("\u0000")) ||
    new Set(expectedPaths).size !== expectedPaths.length ||
    typeof value.approved_snapshot_sha256 !== "string" || !SHA256.test(value.approved_snapshot_sha256) ||
    !isNullableGitObjectId(value.commit_sha) || !isNullableGitObjectId(value.remote_branch_sha) ||
    typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at)) ||
    typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at)) ||
    !isNullableTimestamp(value.committed_at) || !isNullableTimestamp(value.pushed_at)
  ) {
    throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt has an invalid schema.");
  }

  if (state === "READY_FOR_COMMIT" && (value.commit_sha !== null || value.remote_branch_sha !== null || value.committed_at !== null || value.pushed_at !== null)) {
    throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "A READY_FOR_COMMIT receipt contains committed or pushed state.");
  }
  if (state === "COMMITTED" && (value.commit_sha === null || value.remote_branch_sha !== null || value.committed_at === null || value.pushed_at !== null)) {
    throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "A COMMITTED receipt has inconsistent commit or push fields.");
  }
  if (state === "PUSHED" && (value.commit_sha === null || value.remote_branch_sha === null || value.commit_sha !== value.remote_branch_sha || value.committed_at === null || value.pushed_at === null)) {
    throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "A PUSHED receipt has inconsistent commit or remote state.");
  }
}

async function assertCanonicalDirectory(directory: string, create: boolean): Promise<boolean> {
  const resolved = path.resolve(directory);
  if (create) await mkdir(resolved, { recursive: true, mode: 0o700 });
  try {
    const before = await lstat(resolved);
    const canonical = await realpath(resolved);
    const after = await lstat(resolved);
    if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || canonical !== resolved) {
      throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt directory must remain one canonical real directory while authority is accessed.");
    }
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularOrMissing(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt must be a regular non-symlink file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function readStablePublishReceiptBytes(receiptPath: string): Promise<Buffer | null> {
  let pathBefore: Stats;
  try {
    pathBefore = await lstat(receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > MAX_PUBLISH_RECEIPT_BYTES) {
    throw new GitPublishError("PUBLISH_RECEIPT_INVALID", `The Git publish receipt must be a regular non-symlink file no larger than ${MAX_PUBLISH_RECEIPT_BYTES} bytes.`);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(receiptPath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new GitPublishError("PUBLISH_RECEIPT_INVALID", `Cannot safely open the Git publish receipt: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(pathBefore, before) || before.size > MAX_PUBLISH_RECEIPT_BYTES) {
      throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt changed before open.");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt grew while reading.");
    const afterHandle = await handle.stat();
    const afterPath = await lstat(receiptPath).catch((error) => {
      throw new GitPublishError("PUBLISH_RECEIPT_INVALID", `The Git publish receipt path disappeared while reading: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (afterPath.isSymbolicLink() || !afterPath.isFile() || !sameFileIdentity(before, afterHandle) || !sameFileIdentity(before, afterPath)) {
      throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt changed while reading.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readGitPublishReceiptSnapshot(receiptPath: string): Promise<GitPublishReceiptSnapshot | null> {
  const directory = path.dirname(receiptPath);
  if (!await assertCanonicalDirectory(directory, false)) return null;
  const bytes = await readStablePublishReceiptBytes(receiptPath);
  if (bytes === null) return null;
  if (!await assertCanonicalDirectory(directory, false)) throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt directory disappeared after authority was read.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new GitPublishError("PUBLISH_RECEIPT_INVALID", "The Git publish receipt is not valid JSON.");
  }
  assertReceipt(parsed);
  return { receipt: parsed, bytes };
}

export async function readGitPublishReceipt(receiptPath: string): Promise<GitPublishReceipt | null> {
  return (await readGitPublishReceiptSnapshot(receiptPath))?.receipt ?? null;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EBADF") throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeGitPublishReceipt(receiptPath: string, receipt: GitPublishReceipt): Promise<void> {
  assertReceipt(receipt);
  const directory = path.dirname(receiptPath);
  await assertCanonicalDirectory(directory, true);
  await assertRegularOrMissing(receiptPath);
  const temporaryPath = path.join(directory, `.${path.basename(receiptPath)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, receiptPath);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}
