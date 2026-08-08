import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { RevisionError } from "./contracts.js";

async function syncRevisionDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | directoryFlag);
    await handle.sync();
  } catch (error) {
    throw new RevisionError(
      "REVISION_OPERATIONAL_ERROR",
      `Failed to sync revision directory metadata '${directory}': ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeSyncedRevisionTemp(finalPath: string, bytes: Buffer, maximumBytes: number): Promise<string> {
  if (bytes.byteLength > maximumBytes) {
    throw new RevisionError("REVISION_STATE_INVALID", `Revision state write exceeds ${maximumBytes} bytes: ${finalPath}`);
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
    throw new RevisionError(
      "REVISION_OPERATIONAL_ERROR",
      `Failed to persist synced revision bytes '${finalPath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function writeDurableRevisionStateFile(
  finalPath: string,
  bytes: Buffer,
  maximumBytes: number,
): Promise<void> {
  const tempPath = await writeSyncedRevisionTemp(finalPath, bytes, maximumBytes);
  try {
    const existing = await fs.lstat(finalPath).catch((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error),
    );
    if (existing?.isSymbolicLink()) {
      throw new RevisionError("REVISION_STATE_UNSAFE", `Revision state destination is a symlink: ${finalPath}`);
    }
    if (existing && !existing.isFile()) {
      throw new RevisionError("REVISION_STATE_UNSAFE", `Revision state destination is not a regular file: ${finalPath}`);
    }
    await fs.rename(tempPath, finalPath);
    await syncRevisionDirectory(path.dirname(finalPath));
  } catch (error) {
    if (error instanceof RevisionError) throw error;
    throw new RevisionError(
      "REVISION_OPERATIONAL_ERROR",
      `Cannot atomically replace revision state '${finalPath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

export async function installImmutableDurableRevisionStateFile(
  finalPath: string,
  bytes: Buffer,
  maximumBytes: number,
  readExisting: (filePath: string) => Promise<Buffer | null>,
): Promise<void> {
  const tempPath = await writeSyncedRevisionTemp(finalPath, bytes, maximumBytes);
  try {
    try {
      await fs.link(tempPath, finalPath);
      await syncRevisionDirectory(path.dirname(finalPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readExisting(finalPath);
      if (!existing?.equals(bytes)) {
        throw new RevisionError(
          "REVISION_STATE_INVALID",
          `Immutable revision artifact already exists with different bytes: ${finalPath}`,
        );
      }
      await syncRevisionDirectory(path.dirname(finalPath));
    }
  } catch (error) {
    if (error instanceof RevisionError) throw error;
    throw new RevisionError(
      "REVISION_OPERATIONAL_ERROR",
      `Cannot install immutable revision artifact '${finalPath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}
