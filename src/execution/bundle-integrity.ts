import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ARCHIVE_LIMITS } from "../intake/constants.js";
import { hashStableFile, sameStableFileIdentity, StableFileError, type StableFileIdentity } from "../shared/stable-file.js";
import { ExecutionError } from "./errors.js";

export interface BundleSnapshot { sha256: string; files: string[]; }

interface SnapshotBudget {
  entries: number;
  totalBytes: number;
  identities: Map<string, StableFileIdentity>;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRelativePathBounded(relative: string): void {
  if (relative.length > DEFAULT_ARCHIVE_LIMITS.maximumPathLength) {
    throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle path exceeds ${DEFAULT_ARCHIVE_LIMITS.maximumPathLength} characters.`);
  }
  if (relative.split("/").some((segment) => segment.length > DEFAULT_ARCHIVE_LIMITS.maximumPathSegmentLength)) {
    throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle path segment exceeds ${DEFAULT_ARCHIVE_LIMITS.maximumPathSegmentLength} characters.`);
  }
}

function consumeEntry(relative: string, budget: SnapshotBudget): void {
  budget.entries += 1;
  if (budget.entries > DEFAULT_ARCHIVE_LIMITS.maximumEntries) {
    throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle exceeds ${DEFAULT_ARCHIVE_LIMITS.maximumEntries} entries.`);
  }
  assertRelativePathBounded(relative);
}

async function assertCanonicalDirectory(directory: string): Promise<{ dev: number; ino: number }> {
  const resolved = path.resolve(directory);
  const before = await lstat(resolved).catch((error) => { throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle directory cannot be inspected: ${error instanceof Error ? error.message : String(error)}`); });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle traversal requires real directories.");
  const canonical = await realpath(resolved).catch((error) => { throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle directory cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`); });
  if (canonical !== resolved) throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle traversal encountered a non-canonical directory.");
  return { dev: before.dev, ino: before.ino };
}

async function collect(
  root: string,
  current: string,
  budget: SnapshotBudget,
  result: Array<{ relative: string; hash: string }>,
): Promise<void> {
  const directoryIdentity = await assertCanonicalDirectory(current);
  const names = (await readdir(current)).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const full = path.join(current, name);
    const relative = path.relative(root, full).replaceAll(path.sep, "/");
    if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle traversal escaped its canonical root.");
    }
    const info = await lstat(full).catch((error) => { throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle entry '${relative}' cannot be inspected: ${error instanceof Error ? error.message : String(error)}`); });
    consumeEntry(relative, budget);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle contains an unsafe filesystem object.");
    if (info.isDirectory()) {
      await collect(root, full, budget, result);
      continue;
    }
    try {
      const stable = await hashStableFile(full, { maximumBytes: DEFAULT_ARCHIVE_LIMITS.maximumEntryUncompressedBytes });
      budget.totalBytes += stable.identity.size;
      if (!Number.isSafeInteger(budget.totalBytes) || budget.totalBytes > DEFAULT_ARCHIVE_LIMITS.maximumTotalUncompressedBytes) {
        throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle exceeds ${DEFAULT_ARCHIVE_LIMITS.maximumTotalUncompressedBytes} total bytes.`);
      }
      budget.identities.set(full, stable.identity);
      result.push({ relative, hash: stable.sha256 });
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      const message = error instanceof StableFileError ? error.message : error instanceof Error ? error.message : String(error);
      throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle file '${relative}' cannot be stably hashed within trusted limits: ${message}`);
    }
  }

  const [after, afterCanonical, afterNames] = await Promise.all([
    lstat(current),
    realpath(current),
    readdir(current).then((entries) => entries.sort((a, b) => a.localeCompare(b))),
  ]);
  if (
    after.isSymbolicLink() || !after.isDirectory() ||
    after.dev !== directoryIdentity.dev || after.ino !== directoryIdentity.ino ||
    afterCanonical !== path.resolve(current) || !sameNames(names, afterNames)
  ) {
    throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle directory changed during snapshot traversal.");
  }
}

async function assertFilesStillMatch(identities: ReadonlyMap<string, StableFileIdentity>): Promise<void> {
  for (const [filePath, expected] of identities) {
    const current = await lstat(filePath).catch((error) => { throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle file disappeared after hashing: ${error instanceof Error ? error.message : String(error)}`); });
    if (current.isSymbolicLink() || !current.isFile() || !sameStableFileIdentity(expected, {
      dev: current.dev,
      ino: current.ino,
      size: current.size,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
    })) {
      throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle file changed during snapshot traversal.");
    }
  }
}

export async function snapshotBundle(bundlePath: string): Promise<BundleSnapshot> {
  const root = path.resolve(bundlePath);
  await assertCanonicalDirectory(root);
  const budget: SnapshotBudget = { entries: 0, totalBytes: 0, identities: new Map() };
  const files: Array<{ relative: string; hash: string }> = [];
  await collect(root, root, budget, files);
  await assertFilesStillMatch(budget.identities);
  const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { sha256, files: files.map((entry) => `${entry.relative}:${entry.hash}`) };
}

export async function assertBundleUnchanged(bundlePath: string, expected: BundleSnapshot): Promise<void> {
  const actual = await snapshotBundle(bundlePath);
  if (actual.sha256 !== expected.sha256 || actual.files.length !== expected.files.length || actual.files.some((value, index) => value !== expected.files[index])) throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle changed during execution.");
}
