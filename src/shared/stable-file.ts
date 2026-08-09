import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import crypto from "node:crypto";

const DEFAULT_HASH_CHUNK_BYTES = 64 * 1024;

export interface StableFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface StableFileSnapshot {
  bytes: Buffer;
  identity: StableFileIdentity;
}

export class StableFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StableFileError";
  }
}

function identity(stats: Stats): StableFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

export function sameStableFileIdentity(left: StableFileIdentity, right: StableFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameStatsIdentity(left: Stats, right: Stats): boolean {
  return sameStableFileIdentity(identity(left), identity(right));
}

function assertMaximumBytes(maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new StableFileError("Stable-file maximumBytes must be a non-negative safe integer.");
  }
}

async function openStableRegularFile(filePath: string, maximumBytes?: number) {
  if (maximumBytes !== undefined) assertMaximumBytes(maximumBytes);
  let before: Stats;
  try {
    before = await lstat(filePath);
  } catch (error) {
    throw new StableFileError(`Cannot inspect stable file '${filePath}'.`, { cause: error });
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new StableFileError(`Stable file '${filePath}' must be a regular non-symlink file.`);
  }
  if (maximumBytes !== undefined && before.size > maximumBytes) {
    throw new StableFileError(`Stable file '${filePath}' exceeds ${maximumBytes} bytes.`);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    throw new StableFileError(`Cannot safely open stable file '${filePath}'.`, { cause: error });
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameStatsIdentity(before, opened)) {
      throw new StableFileError(`Stable file '${filePath}' changed before open completed.`);
    }
    if (maximumBytes !== undefined && opened.size > maximumBytes) {
      throw new StableFileError(`Stable file '${filePath}' exceeds ${maximumBytes} bytes.`);
    }
    return { handle, opened, identity: identity(opened) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertStableAfterRead(filePath: string, opened: Stats, handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  const afterHandle = await handle.stat();
  let afterPath: Stats;
  try {
    afterPath = await lstat(filePath);
  } catch (error) {
    throw new StableFileError(`Stable file path '${filePath}' disappeared during read.`, { cause: error });
  }
  if (
    !afterHandle.isFile() || !afterPath.isFile() || afterPath.isSymbolicLink() ||
    !sameStatsIdentity(opened, afterHandle) || !sameStatsIdentity(opened, afterPath)
  ) {
    throw new StableFileError(`Stable file '${filePath}' changed during read.`);
  }
}

export async function readStableFile(filePath: string, maximumBytes: number): Promise<StableFileSnapshot> {
  const stable = await openStableRegularFile(filePath, maximumBytes);
  try {
    const bytes = Buffer.alloc(stable.opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await stable.handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new StableFileError(`Stable file '${filePath}' was truncated during read.`);
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await stable.handle.read(probe, 0, 1, offset)).bytesRead !== 0) {
      throw new StableFileError(`Stable file '${filePath}' grew during read.`);
    }
    await assertStableAfterRead(filePath, stable.opened, stable.handle);
    return { bytes, identity: stable.identity };
  } finally {
    await stable.handle.close().catch(() => undefined);
  }
}

export async function hashStableFile(
  filePath: string,
  options: { maximumBytes?: number; chunkBytes?: number } = {},
): Promise<{ sha256: string; identity: StableFileIdentity }> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_HASH_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 16 * 1024 * 1024) {
    throw new StableFileError("Stable-file chunkBytes must be a bounded positive safe integer.");
  }
  const stable = await openStableRegularFile(filePath, options.maximumBytes);
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, stable.opened.size)));
    let offset = 0;
    while (offset < stable.opened.size) {
      const length = Math.min(buffer.byteLength, stable.opened.size - offset);
      const { bytesRead } = await stable.handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) throw new StableFileError(`Stable file '${filePath}' was truncated during hashing.`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await stable.handle.read(probe, 0, 1, offset)).bytesRead !== 0) {
      throw new StableFileError(`Stable file '${filePath}' grew during hashing.`);
    }
    await assertStableAfterRead(filePath, stable.opened, stable.handle);
    return { sha256: hash.digest("hex"), identity: stable.identity };
  } finally {
    await stable.handle.close().catch(() => undefined);
  }
}
