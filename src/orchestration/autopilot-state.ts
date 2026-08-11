import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_AUTOPILOT_RECEIPT_BYTES = 256 * 1024;

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertSafeAncestorChain(filePath: string): Promise<boolean> {
  const resolved = path.resolve(filePath);
  const archiveDirectory = path.dirname(resolved);
  const taskDirectory = path.dirname(archiveDirectory);
  const runsDirectory = path.dirname(taskDirectory);
  const stateRoot = path.dirname(runsDirectory);
  if (path.basename(runsDirectory) !== "runs") {
    throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt is outside the canonical state/runs hierarchy.");
  }
  for (const directory of [stateRoot, runsDirectory, taskDirectory, archiveDirectory]) {
    let info: Stats;
    try { info = await fs.lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt ancestor is not a real directory.");
    }
  }
  return true;
}

/**
 * Read a bounded authority file through a stable descriptor. This mirrors the
 * hardened orchestration-ledger pattern: every ancestor is a real directory,
 * the final file is never followed through a symlink, path identity is stable,
 * and the file cannot grow or truncate while bytes are being consumed.
 */
export async function readStableAutopilotBytes(filePath: string): Promise<Buffer | null> {
  if (!await assertSafeAncestorChain(filePath)) return null;
  let pathStat: Stats;
  try {
    pathStat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > MAX_AUTOPILOT_RECEIPT_BYTES) {
    throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt is not a bounded regular non-symlink file.");
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new Error(`AUTOPILOT_RECEIPT_UNSAFE: durable receipt cannot be opened safely: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_AUTOPILOT_RECEIPT_BYTES || !sameFile(before, pathStat) || before.size !== pathStat.size) {
      throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt changed before stable open.");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt was truncated while reading.");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt grew while reading.");
    }
    const afterHandle = await handle.stat();
    const afterPath = await fs.lstat(filePath);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFile(before, afterHandle) ||
      !sameFile(before, afterPath) ||
      afterHandle.size !== before.size ||
      afterPath.size !== before.size
    ) {
      throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt changed while reading.");
    }
    await assertSafeAncestorChain(filePath);
    return bytes;
  } finally {
    await handle.close();
  }
}
