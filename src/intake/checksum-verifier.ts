import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { readJsonFile } from "../shared/read-json.js";
import { IntakeError } from "./errors.js";

interface ChecksumDocument {
  algorithm: "sha256";
  files: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateChecksumPath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function listRegularFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const name of await readdir(current)) {
    const absolute = path.join(current, name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new IntakeError("CHECKSUMS_INVALID", "Extracted symbolic links are not allowed.", name);
    }
    if (info.isDirectory()) {
      result.push(...(await listRegularFiles(root, absolute)));
    } else if (info.isFile()) {
      result.push(path.relative(root, absolute).split(path.sep).join("/"));
    } else {
      throw new IntakeError("CHECKSUMS_INVALID", "Extracted special files are not allowed.", name);
    }
  }
  return result;
}

export async function verifyBundleChecksums(bundleDirectory: string): Promise<void> {
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
  for (const [fileName, digest] of Object.entries(raw.files)) {
    if (fileName === "checksums.json" || !validateChecksumPath(fileName)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Unsafe checksum path: ${fileName}`);
    }
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new IntakeError("CHECKSUMS_INVALID", `Invalid sha256 digest for ${fileName}.`);
    }
    listed.set(fileName.normalize("NFC"), digest);
  }

  const actual = (await listRegularFiles(bundleDirectory)).filter((name) => name !== "checksums.json");
  const actualSet = new Set(actual.map((name) => name.normalize("NFC")));

  for (const fileName of actualSet) {
    if (!listed.has(fileName)) throw new IntakeError("CHECKSUM_MISSING_FILE", `File is missing from checksums.json: ${fileName}`);
  }
  for (const fileName of listed.keys()) {
    if (!actualSet.has(fileName)) throw new IntakeError("CHECKSUM_UNKNOWN_FILE", `Checksum lists a nonexistent file: ${fileName}`);
  }

  for (const fileName of actual) {
    const normalized = fileName.normalize("NFC");
    const actualDigest = await hashFile(path.join(bundleDirectory, ...fileName.split("/")));
    if (actualDigest !== listed.get(normalized)) {
      throw new IntakeError("CHECKSUM_MISMATCH", `Checksum mismatch for ${fileName}.`);
    }
  }
}
