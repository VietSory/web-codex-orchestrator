import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { RunReceipt } from "./contracts.js";

async function ensureDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
}

export function runDirectory(stateDirectory: string, taskId: string, archiveSha256: string): string {
  return path.join(path.resolve(stateDirectory), "runs", taskId, archiveSha256);
}

export async function readRunReceipt(stateDirectory: string, taskId: string, archiveSha256: string): Promise<RunReceipt | undefined> {
  try {
    const receiptPath = path.join(runDirectory(stateDirectory, taskId, archiveSha256), "run.json");
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Run receipt must be a regular non-symlink file.");
    return JSON.parse(await readFile(receiptPath, "utf8")) as RunReceipt;
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

export async function writeRunReceipt(stateDirectory: string, receipt: RunReceipt): Promise<void> {
  const directory = runDirectory(stateDirectory, receipt.task_id, receipt.archive_sha256);
  await ensureDirectory(directory);
  await atomicWriteJson(path.join(directory, "run.json"), receipt);
  await atomicWriteJson(path.join(directory, "preparation.json"), receipt);
}

export async function clearRunDirectory(stateDirectory: string, taskId: string, archiveSha256: string): Promise<void> {
  await rm(runDirectory(stateDirectory, taskId, archiveSha256), { recursive: true, force: true });
}
