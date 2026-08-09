import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { hashStableFile, readStableFile, StableFileError } from "../shared/stable-file.js";
import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from "./constants.js";
import { IntakeError } from "./errors.js";

interface ChecksumDocument {
  algorithm: "sha256";
  files: Record<string, string>;
}

interface TraversalBudget {
  limits: ArchiveLimits;
  entries: number;
  totalBytes: number;
}

const MAX_CHECKSUM_DOCUMENT_BYTES = 1 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateChecksumPath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sameDirectoryIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateLimits(limits: ArchiveLimits): void {
  const values = [
    limits.maximumArchiveBytes,
    limits.maximumEntries,
    limits.maximumEntryUncompressedBytes,
    limits.maximumTotalUncompressedBytes,
    limits.maximumPathLength,
    limits.maximumPathSegmentLength,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new IntakeError("CHECKSUMS_INVALID", "Checksum revalidation limits must be positive safe integers.");
  }
}

function assertPathWithinLimits(relative: string, limits: ArchiveLimits): void {
  const normalized = relative.split(path.sep).join("/");
  if (normalized.length > limits.maximumPathLength) {
    throw new IntakeError("CHECKSUMS_INVALID", `Checksum traversal path exceeds ${limits.maximumPathLength} characters.`, normalized);
  }
  if (normalized.split("/").some((segment) => segment.length > limits.maximumPathSegmentLength)) {
    throw new IntakeError("CHECKSUMS_INVALID", `Checksum traversal path segment exceeds ${limits.maximumPathSegmentLength} characters.`, normalized);
  }
}

function consumeEntryBudget(relative: string, info: Stats, budget: TraversalBudget): void {
  budget.entries += 1;
  if (budget.entries > budget.limits.maximumEntries) {
    throw new IntakeError("CHECKSUMS_INVALID", `Checksum traversal exceeds ${budget.limits.maximumEntries} entries.`, relative);
  }
  assertPathWithinLimits(relative, budget.limits);
  if (!info.isFile()) return;
  if (info.size > budget.limits.maximumEntryUncompressedBytes) {
    throw new IntakeError("CHECKSUMS_INVALID", `Checksum file exceeds ${budget.limits.maximumEntryUncompressedBytes} bytes.`, relative);
  }
  budget.totalBytes += info.size;
  if (budget.totalBytes > budget.limits.maximumTotalUncompressedBytes) {
    throw new IntakeError("CHECKSUMS_INVALID", `Checksum traversal exceeds ${budget.limits.maximumTotalUncompressedBytes} total bytes.`, relative);
  }
}

async function listRegularFiles(root: string, current = root, budget?: TraversalBudget): Promise<string[]> {
  const before = await lstat(current);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new IntakeError("CHECKSUMS_INVALID", "Checksum traversal requires real directories.", path.relative(root, current));
  }
  const canonical = await realpath(current);
  if (canonical !== path.resolve(current)) {
    throw new IntakeError("CHECKSUMS_INVALID", "Checksum traversal encountered a non-canonical directory.", path.relative(root, current));
  }

  const result: string[] = [];
  for (const name of await readdir(current)) {
    const absolute = path.join(current, name);
    const relative = path.relative(root, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new IntakeError("CHECKSUMS_INVALID", "Checksum traversal escaped the bundle directory.", name);
    }
    const info = await lstat(absolute);
    if (budget) consumeEntryBudget(relative, info, budget);
    if (info.isSymbolicLink()) {
      throw new IntakeError("CHECKSUMS_INVALID", "Extracted symbolic links are not allowed.", name);
    }
    if (info.isDirectory()) {
      result.push(...(await listRegularFiles(root, absolute, budget)));
    } else if (info.isFile()) {
      result.push(relative.split(path.sep).join("/"));
    } else {
      throw new IntakeError("CHECKSUMS_INVALID", "Extracted special files are not allowed.", name);
    }
  }

  const after = await lstat(current);
  if (after.isSymbolicLink() || !after.isDirectory() || !sameDirectoryIdentity(before, after)) {
    throw new IntakeError("CHECKSUMS_INVALID", "Checksum directory changed during traversal.", path.relative(root, current));
  }
  return result;
}

export async function verifyBundleChecksums(
  bundleDirectory: string,
  trustedLimits?: ArchiveLimits,
): Promise<void> {
  const resolvedBundle = path.resolve(bundleDirectory);
  const limits = trustedLimits ? { ...trustedLimits } : undefined;
  if (limits) validateLimits(limits);

  let raw: unknown;
  try {
    const maximumChecksumBytes = limits
      ? Math.min(MAX_CHECKSUM_DOCUMENT_BYTES, limits.maximumEntryUncompressedBytes)
      : MAX_CHECKSUM_DOCUMENT_BYTES;
    const snapshot = await readStableFile(path.join(resolvedBundle, "checksums.json"), maximumChecksumBytes);
    raw = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IntakeError("CHECKSUMS_INVALID", `checksums.json is not stable valid JSON: ${message}`);
  }

  if (!isRecord(raw) || raw.algorithm !== "sha256" || !isRecord(raw.files)) {
    throw new IntakeError("CHECKSUMS_INVALID", "checksums.json must contain sha256 and a files object.");
  }

  const listed = new Map<string, string>();
  for (const [fileName, digest] of Object.entries(raw.files)) {
    if (fileName === "checksums.json" || !validateChecksumPath(fileName)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Unsafe checksum path: ${fileName}`);
    }
    if (limits) assertPathWithinLimits(fileName, limits);
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Invalid sha256 digest for ${fileName}.`);
    }
    const normalized = fileName.normalize("NFC");
    if (listed.has(normalized)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Duplicate checksum path after NFC normalization: ${fileName}`);
    }
    listed.set(normalized, digest);
  }

  const budget = limits ? { limits, entries: 0, totalBytes: 0 } : undefined;
  const actual = (await listRegularFiles(resolvedBundle, resolvedBundle, budget)).filter((name) => name !== "checksums.json");
  const actualSet = new Set(actual.map((name) => name.normalize("NFC")));
  if (actualSet.size !== actual.length) {
    throw new IntakeError("CHECKSUMS_INVALID", "Bundle contains duplicate file paths after NFC normalization.");
  }

  for (const fileName of actualSet) {
    if (!listed.has(fileName)) throw new IntakeError("CHECKSUM_MISSING_FILE", `File is missing from checksums.json: ${fileName}`);
  }
  for (const fileName of listed.keys()) {
    if (!actualSet.has(fileName)) throw new IntakeError("CHECKSUM_UNKNOWN_FILE", `Checksum lists a nonexistent file: ${fileName}`);
  }

  for (const fileName of actual) {
    const normalized = fileName.normalize("NFC");
    let actualDigest: string;
    try {
      actualDigest = (await hashStableFile(
        path.join(resolvedBundle, ...fileName.split("/")),
        limits ? { maximumBytes: limits.maximumEntryUncompressedBytes } : {},
      )).sha256;
    } catch (error) {
      const message = error instanceof StableFileError ? error.message : error instanceof Error ? error.message : String(error);
      throw new IntakeError("CHECKSUMS_INVALID", `Cannot stably hash ${fileName}: ${message}`, fileName);
    }
    if (actualDigest !== listed.get(normalized)) {
      throw new IntakeError("CHECKSUM_MISMATCH", `Checksum mismatch for ${fileName}.`);
    }
  }
}

export { DEFAULT_ARCHIVE_LIMITS };
