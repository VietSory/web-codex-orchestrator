import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../shared/read-json.js";
import type { RunReceipt } from "./contracts.js";

const RUN_RECEIPT_MAX_BYTES = 1 * 1024 * 1024;

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

export function runDirectory(stateDirectory: string, taskId: string, archiveSha256: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(archiveSha256)) {
    throw new Error("Run receipt identifiers are unsafe.");
  }
  return path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256);
}

export async function readRunReceipt(stateDirectory: string, taskId: string, archiveSha256: string): Promise<RunReceipt | undefined> {
  try {
    const directory = runDirectory(stateDirectory, taskId, archiveSha256);
    if (!await existingDirectoryChain(directory)) return undefined;
    const receiptPath = path.join(directory, "run.json");
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Run receipt must be a regular non-symlink file.");
    return await readJsonFile(receiptPath, RUN_RECEIPT_MAX_BYTES) as RunReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let committed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, filePath);
    committed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteText(filePath: string, value: string): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let committed = false;
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, filePath);
    committed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeRunReceipt(stateDirectory: string, receipt: RunReceipt): Promise<void> {
  const directory = runDirectory(stateDirectory, receipt.task_id, receipt.archive_sha256);
  await ensureDirectory(directory);
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
