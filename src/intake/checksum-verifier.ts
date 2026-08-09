import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { hashStableFile, readStableFile, StableFileError } from "../shared/stable-file.js";
import { IntakeError } from "./errors.js";

interface ChecksumDocument {
  algorithm: "sha256";
  files: Record<string, string>;
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

async function listRegularFiles(root: string, current = root): Promise<string[]> {
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
    if (info.isSymbolicLink()) {
      throw new IntakeError("CHECKSUMS_INVALID", "Extracted symbolic links are not allowed.", name);
    }
    if (info.isDirectory()) {
      result.push(...(await listRegularFiles(root, absolute)));
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

export async function verifyBundleChecksums(bundleDirectory: string): Promise<void> {
  const resolvedBundle = path.resolve(bundleDirectory);
  let raw: unknown;
  try {
    const snapshot = await readStableFile(path.join(resolvedBundle, "checksums.json"), MAX_CHECKSUM_DOCUMENT_BYTES);
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
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Invalid sha256 digest for ${fileName}.`);
    }
    const normalized = fileName.normalize("NFC");
    if (listed.has(normalized)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Duplicate checksum path after NFC normalization: ${fileName}`);
    }
    listed.set(normalized, digest);
  }

  const actual = (await listRegularFiles(resolvedBundle)).filter((name) => name !== "checksums.json");
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
      actualDigest = (await hashStableFile(path.join(resolvedBundle, ...fileName.split("/")))).sha256;
    } catch (error) {
      const message = error instanceof StableFileError ? error.message : error instanceof Error ? error.message : String(error);
      throw new IntakeError("CHECKSUMS_INVALID", `Cannot stably hash ${fileName}: ${message}`, fileName);
    }
    if (actualDigest !== listed.get(normalized)) {
      throw new IntakeError("CHECKSUM_MISMATCH", `Checksum mismatch for ${fileName}.`);
    }
  }
}
