import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ExecutorError } from "./contracts.js";

export const MAX_EXECUTOR_FILE_BYTES = 8 * 1024 * 1024;

export interface StableFileSnapshot {
  bytes: Buffer;
  sha256: string;
  mode: number;
}

function digest(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

async function assertAncestorChain(root: string, relativePath: string): Promise<{ root: string; target: string; parent: string }> {
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, ...relativePath.split("/"));
  const relative = path.relative(realRoot, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", `Operation path escapes worktree: ${relativePath}`);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = realRoot;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]!);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", `Operation ancestor is non-directory or symlink: ${relativePath}`);
  }
  return { root: realRoot, target, parent: path.dirname(target) };
}

async function ensureCreateAncestorChain(root: string, relativePath: string): Promise<{ root: string; target: string; parent: string }> {
  const resolved = await assertAncestorChain(root, relativePath);
  const segments = path.relative(resolved.root, resolved.parent).split(path.sep).filter(Boolean);
  let current = resolved.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { await fs.mkdir(current, { mode: 0o755 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", `Cannot create operation ancestor: ${relativePath}`); }
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(current) !== current) throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", `Operation ancestor is missing, non-directory, or symlink: ${relativePath}`);
  }
  return resolved;
}

async function assertStableAfter(target: string, before: Stats, handle: fs.FileHandle): Promise<void> {
  const fdAfter = await handle.stat();
  const pathAfter = await fs.lstat(target).catch(() => null);
  if (!pathAfter || pathAfter.isSymbolicLink() || !pathAfter.isFile() || fdAfter.dev !== before.dev || fdAfter.ino !== before.ino || fdAfter.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `File changed during bounded read: ${target}`);
}

export async function readStableWorktreeFile(worktree: string, relativePath: string): Promise<StableFileSnapshot | null> {
  const { target } = await assertAncestorChain(worktree, relativePath);
  let pathStat;
  try { pathStat = await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", `Target is not a regular non-symlink file: ${relativePath}`);
  if (pathStat.size > MAX_EXECUTOR_FILE_BYTES) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Target exceeds executor file cap: ${relativePath}`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(target, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new ExecutorError("EXECUTOR_WORKTREE_UNSAFE", `Cannot safely open target '${relativePath}': ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino || before.size !== pathStat.size || before.size > MAX_EXECUTOR_FILE_BYTES) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Target changed before bounded read: ${relativePath}`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Target truncated during bounded read: ${relativePath}`);
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Target grew during bounded read: ${relativePath}`);
    await assertStableAfter(target, before, handle);
    return { bytes, sha256: digest(bytes), mode: before.mode & 0o777 };
  } finally { await handle.close(); }
}

export async function writeExactWorktreeFile(worktree: string, relativePath: string, bytes: Buffer, mode: number, mustBeAbsent: boolean): Promise<void> {
  if (bytes.byteLength > MAX_EXECUTOR_FILE_BYTES) throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Postimage exceeds executor file cap: ${relativePath}`);
  const { target, parent } = mustBeAbsent ? await ensureCreateAncestorChain(worktree, relativePath) : await assertAncestorChain(worktree, relativePath);
  if (mustBeAbsent) {
    const exists = await fs.lstat(target).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (exists) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Create target exists: ${relativePath}`);
  }
  const temp = path.join(parent, `.wco-${process.pid}-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, bytes, { flag: "wx", mode: mode & 0o777 });
  try {
    await fs.chmod(temp, mode & 0o777).catch(() => undefined);
    if (mustBeAbsent) {
      try { await fs.link(temp, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Create target appeared during apply: ${relativePath}`);
        throw error;
      }
    } else {
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing || existing.isSymbolicLink() || !existing.isFile()) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Replace target is no longer a regular file: ${relativePath}`);
      await fs.rename(temp, target);
      const post = await readStableWorktreeFile(worktree, relativePath);
      if (!post || post.sha256 !== digest(bytes)) throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Replace postimage mismatch: ${relativePath}`);
      return;
    }
    const post = await readStableWorktreeFile(worktree, relativePath);
    if (!post || post.sha256 !== digest(bytes)) throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Create postimage mismatch: ${relativePath}`);
  } finally { await fs.unlink(temp).catch(() => undefined); }
}

export async function deleteExactWorktreeFile(worktree: string, relativePath: string): Promise<void> {
  const { target } = await assertAncestorChain(worktree, relativePath);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Delete target is no longer a regular file: ${relativePath}`);
  await fs.unlink(target);
  const post = await fs.lstat(target).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
  if (post) throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Delete target still exists: ${relativePath}`);
}
