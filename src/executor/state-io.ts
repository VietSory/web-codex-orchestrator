import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ExecutorError } from "./contracts.js";

export async function ensureSecureExecutorSubdirectory(rootDirectory: string, directory: string): Promise<void> {
  const root = await fs.realpath(rootDirectory);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state subdirectory escapes its root: ${directory}`);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state ancestor is not a real directory: ${current}`);
    }
  }
  const realTarget = await fs.realpath(target);
  const realRelative = path.relative(root, realTarget);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state realpath escapes its root: ${directory}`);
  }
}

async function openStableRegularFile(filePath: string, maximumBytes: number): Promise<{ handle: fs.FileHandle; before: Stats }> {
  const pathBefore = await fs.lstat(filePath);
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.size > maximumBytes) {
    throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state file is unsafe or exceeds ${maximumBytes} bytes: ${filePath}`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new ExecutorError("EXECUTOR_STATE_INVALID", `Cannot safely open executor state file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size || before.size > maximumBytes) {
      throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state file changed before open: ${filePath}`);
    }
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readStableExecutorStateFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const { handle, before } = await openStableRegularFile(filePath, maximumBytes);
  try {
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state file truncated while reading: ${filePath}`);
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state file grew while reading: ${filePath}`);
    }
    const afterHandle = await handle.stat();
    const afterPath = await fs.lstat(filePath).catch((error) => {
      throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state path disappeared while reading '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
    });
    if (afterPath.isSymbolicLink() || !afterPath.isFile() || afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size || afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size) {
      throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state file changed while reading: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function syncExecutorDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | directoryFlag);
    await handle.sync();
  } catch (error) {
    throw new ExecutorError(
      "EXECUTOR_STATE_DURABILITY",
      `Failed to sync executor directory metadata '${directory}': ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeSyncedTemp(finalPath: string, bytes: Buffer, maximumBytes: number): Promise<string> {
  if (bytes.byteLength > maximumBytes) {
    throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state write exceeds ${maximumBytes} bytes: ${finalPath}`);
  }
  const directory = path.dirname(finalPath);
  const tempPath = path.join(directory, `.${path.basename(finalPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    return tempPath;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function writeDurableExecutorStateFile(
  finalPath: string,
  bytes: Buffer,
  maximumBytes: number,
): Promise<void> {
  const tempPath = await writeSyncedTemp(finalPath, bytes, maximumBytes);
  try {
    const existing = await fs.lstat(finalPath).catch((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error),
    );
    if (existing?.isSymbolicLink()) {
      throw new ExecutorError("EXECUTOR_STATE_INVALID", `Executor state destination is a symlink: ${finalPath}`);
    }
    await fs.rename(tempPath, finalPath);
    await syncExecutorDirectory(path.dirname(finalPath));
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

export async function installImmutableDurableExecutorStateFile(
  finalPath: string,
  bytes: Buffer,
  maximumBytes: number,
): Promise<void> {
  const tempPath = await writeSyncedTemp(finalPath, bytes, maximumBytes);
  try {
    try {
      await fs.link(tempPath, finalPath);
      await syncExecutorDirectory(path.dirname(finalPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readStableExecutorStateFile(finalPath, maximumBytes);
      if (!existing.equals(bytes)) {
        throw new ExecutorError(
          "EXECUTOR_STATE_INVALID",
          `Immutable executor state path already exists with different bytes: ${finalPath}`,
        );
      }
    }
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}
