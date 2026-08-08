import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { readJsonFile } from "../shared/read-json.js";
import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from "./constants.js";
import { IntakeError } from "./errors.js";

interface ChecksumDocument {
  algorithm: "sha256";
  files: Record<string, string>;
}

interface InventoryBudget {
  files: number;
  bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateChecksumPath(value: string, limits: ArchiveLimits): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || value.length > limits.maximumPathLength) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment.length <= limits.maximumPathSegmentLength && segment !== "." && segment !== "..");
}

async function hashStableFile(filePath: string, expected: Stats, maximumBytes: number): Promise<string> {
  if (expected.isSymbolicLink() || !expected.isFile() || expected.size > maximumBytes) {
    throw new IntakeError("CHECKSUMS_INVALID", `Checksum target is unsafe or exceeds ${maximumBytes} bytes: ${filePath}`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow).catch((error) => {
    throw new IntakeError("CHECKSUMS_INVALID", `Cannot safely open checksum target: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size || before.size > maximumBytes) {
      throw new IntakeError("CHECKSUMS_INVALID", `Checksum target changed before open: ${filePath}`);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const requested = Math.min(chunk.length, before.size - offset);
      const { bytesRead } = await handle.read(chunk, 0, requested, offset);
      if (bytesRead === 0) throw new IntakeError("CHECKSUMS_INVALID", `Checksum target was truncated while reading: ${filePath}`);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
      throw new IntakeError("CHECKSUMS_INVALID", `Checksum target grew while reading: ${filePath}`);
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() ||
      afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
      afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size
    ) {
      throw new IntakeError("CHECKSUMS_INVALID", `Checksum target changed while reading: ${filePath}`);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function listRegularFiles(
  root: string,
  limits: ArchiveLimits,
  current = root,
  budget: InventoryBudget = { files: 0, bytes: 0 },
): Promise<Array<{ relative: string; stat: Stats }>> {
  const result: Array<{ relative: string; stat: Stats }> = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new IntakeError("CHECKSUMS_INVALID", "Extracted symbolic links are not allowed.", entry.name);
    }
    if (info.isDirectory()) {
      result.push(...(await listRegularFiles(root, limits, absolute, budget)));
      continue;
    }
    if (!info.isFile()) {
      throw new IntakeError("CHECKSUMS_INVALID", "Extracted special files are not allowed.", entry.name);
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!validateChecksumPath(relative, limits) && relative !== "checksums.json") {
      throw new IntakeError("CHECKSUMS_INVALID", `Extracted file path is outside bounded archive policy: ${relative}`);
    }
    budget.files += 1;
    budget.bytes += info.size;
    if (budget.files > limits.maximumEntries) throw new IntakeError("CHECKSUMS_INVALID", `Accepted bundle exceeds ${limits.maximumEntries} files during re-attestation.`);
    if (info.size > limits.maximumEntryUncompressedBytes) throw new IntakeError("CHECKSUMS_INVALID", `Accepted bundle file exceeds ${limits.maximumEntryUncompressedBytes} bytes: ${relative}`);
    if (budget.bytes > limits.maximumTotalUncompressedBytes) throw new IntakeError("CHECKSUMS_INVALID", `Accepted bundle exceeds ${limits.maximumTotalUncompressedBytes} aggregate bytes during re-attestation.`);
    result.push({ relative, stat: info });
  }
  return result;
}

export async function verifyBundleChecksums(bundleDirectory: string, overrides: Partial<ArchiveLimits> = {}): Promise<void> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  let raw: unknown;
  try {
    raw = await readJsonFile(path.join(bundleDirectory, "checksums.json"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IntakeError("CHECKSUMS_INVALID", `checksums.json is not valid JSON: ${message}`);
  }

  if (!isRecord(raw) || raw.algorithm !== "sha256" || !isRecord(raw.files)) {
    throw new IntakeError("CHECKSUMS_INVALID", "checksums.json must contain sha256 and a files object.");
  }

  const listed = new Map<string, string>();
  if (Object.keys(raw.files).length > limits.maximumEntries) throw new IntakeError("CHECKSUMS_INVALID", "checksums.json lists too many files.");
  for (const [fileName, digest] of Object.entries(raw.files)) {
    if (fileName === "checksums.json" || !validateChecksumPath(fileName, limits)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Unsafe checksum path: ${fileName}`);
    }
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Invalid sha256 digest for ${fileName}.`);
    }
    const normalized = fileName.normalize("NFC");
    if (listed.has(normalized)) throw new IntakeError("CHECKSUMS_INVALID", `Duplicate normalized checksum path: ${fileName}`);
    listed.set(normalized, digest);
  }

  const inventory = await listRegularFiles(bundleDirectory, limits);
  const actual = inventory.filter((entry) => entry.relative !== "checksums.json");
  const actualSet = new Set(actual.map((entry) => entry.relative.normalize("NFC")));

  for (const fileName of actualSet) {
    if (!listed.has(fileName)) throw new IntakeError("CHECKSUM_MISSING_FILE", `File is missing from checksums.json: ${fileName}`);
  }
  for (const fileName of listed.keys()) {
    if (!actualSet.has(fileName)) throw new IntakeError("CHECKSUM_UNKNOWN_FILE", `Checksum lists a nonexistent file: ${fileName}`);
  }

  for (const entry of actual) {
    const normalized = entry.relative.normalize("NFC");
    const actualDigest = await hashStableFile(path.join(bundleDirectory, ...entry.relative.split("/")), entry.stat, limits.maximumEntryUncompressedBytes);
    if (actualDigest !== listed.get(normalized)) {
      throw new IntakeError("CHECKSUM_MISMATCH", `Checksum mismatch for ${entry.relative}.`);
    }
  }
}
