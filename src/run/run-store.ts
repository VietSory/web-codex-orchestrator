import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { RunReceipt } from "./contracts.js";
import { RUN_STATES } from "./contracts.js";

const MAX_RUN_RECEIPT_BYTES = 1024 * 1024;

async function ensureDirectory(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Run lifecycle path must be a real directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("Run lifecycle path is unsafe.");
    }
  }
}

async function existingDirectoryChain(target: string): Promise<boolean> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Run lifecycle path must be a real directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY | directoryFlag);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EBADF") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStableFile(filePath: string, maximumBytes: number): Promise<Buffer | undefined> {
  let pathBefore: Stats;
  try {
    pathBefore = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > maximumBytes) {
    throw new Error(`Run receipt must be a regular non-symlink file no larger than ${maximumBytes} bytes.`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > maximumBytes) {
      throw new Error("Run receipt changed before open.");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("Run receipt was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new Error("Run receipt grew while reading.");
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) {
      throw new Error("Run receipt changed while reading.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertRunReceiptIdentity(value: unknown, taskId: string, archiveSha256: string): asserts value is RunReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run receipt must be a JSON object.");
  const receipt = value as Record<string, unknown>;
  if (
    receipt.run_version !== "1.0" ||
    receipt.task_id !== taskId ||
    receipt.archive_sha256 !== archiveSha256 ||
    receipt.run_id !== `${taskId}:${archiveSha256}` ||
    (receipt.bundle_schema_version !== "1.2" && receipt.bundle_schema_version !== "1.3") ||
    typeof receipt.status !== "string" || !RUN_STATES.includes(receipt.status as never) ||
    typeof receipt.state !== "string" || !RUN_STATES.includes(receipt.state as never) ||
    !Array.isArray(receipt.checks) || receipt.checks.length > 512 || receipt.checks.some((item) => typeof item !== "string" || item.length > 4096) ||
    !Array.isArray(receipt.errors) || receipt.errors.length > 256 ||
    typeof receipt.created_at !== "string" || !Number.isFinite(Date.parse(receipt.created_at)) ||
    typeof receipt.updated_at !== "string" || !Number.isFinite(Date.parse(receipt.updated_at))
  ) {
    throw new Error("Run receipt schema or path identity is invalid.");
  }
}

async function assertRegularOrMissing(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Run lifecycle destination must be a regular non-symlink file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function runDirectory(stateDirectory: string, taskId: string, archiveSha256: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(archiveSha256)) {
    throw new Error("Run receipt identifiers are unsafe.");
  }
  return path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256);
}

export async function readRunReceipt(stateDirectory: string, taskId: string, archiveSha256: string): Promise<RunReceipt | undefined> {
  const directory = runDirectory(stateDirectory, taskId, archiveSha256);
  if (!await existingDirectoryChain(directory)) return undefined;
  const receiptPath = path.join(directory, "run.json");
  const bytes = await readStableFile(receiptPath, MAX_RUN_RECEIPT_BYTES);
  if (!bytes) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Run receipt is not valid JSON."); }
  assertRunReceiptIdentity(parsed, taskId, archiveSha256);
  return parsed;
}

async function atomicWriteBytes(filePath: string, bytes: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory);
  await assertRegularOrMissing(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertRegularOrMissing(filePath);
    await rename(temporary, filePath);
    await syncDirectory(directory);
    committed = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (path.basename(filePath) === "run.json" || path.basename(filePath) === "preparation.json") {
    if (bytes.byteLength > MAX_RUN_RECEIPT_BYTES) throw new Error(`Run receipt exceeds ${MAX_RUN_RECEIPT_BYTES} bytes.`);
  }
  await atomicWriteBytes(filePath, bytes);
}

export async function atomicWriteText(filePath: string, value: string): Promise<void> {
  await atomicWriteBytes(filePath, Buffer.from(value, "utf8"));
}

export async function writeRunReceipt(stateDirectory: string, receipt: RunReceipt): Promise<void> {
  const directory = runDirectory(stateDirectory, receipt.task_id, receipt.archive_sha256);
  await ensureDirectory(directory);
  assertRunReceiptIdentity(receipt, receipt.task_id, receipt.archive_sha256);
  await atomicWriteJson(path.join(directory, "run.json"), receipt);
  await atomicWriteJson(path.join(directory, "preparation.json"), receipt);
}

export async function clearRunDirectory(stateDirectory: string, taskId: string, archiveSha256: string): Promise<void> {
  const directory = runDirectory(stateDirectory, taskId, archiveSha256);
  if (!await existingDirectoryChain(path.dirname(directory))) return;
  const info = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
  await rm(directory, { recursive: true, force: false });
}
