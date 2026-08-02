import { createWriteStream } from "node:fs";
import { mkdir, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";

import type { ArchiveLimits } from "./constants.js";
import type { ArchiveInspection, SafeZipEntry } from "./contracts.js";
import { IntakeError, isIntakeError } from "./errors.js";
import { createEntryPolicyState, inspectEntry, resolveExtractionPath } from "./entry-policy.js";

const YAUZL_OPTIONS = {
  lazyEntries: true,
  decodeStrings: true,
  validateEntrySizes: true,
  strictFileNames: true,
} as const;

export interface ExtractionOptions {
  /** Test seam; production callers never execute archive content here. */
  onFileExtracted?: (outputPath: string) => Promise<void> | void;
}

function malformedArchive(error: unknown): IntakeError {
  if (isIntakeError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("invalid characters in fileName") ||
    message.startsWith("absolute path:") ||
    message.startsWith("invalid relative path:")
  ) {
    return new IntakeError("ZIP_UNSAFE_PATH", message);
  }
  return new IntakeError("ZIP_MALFORMED", `ZIP archive could not be read safely: ${message}`);
}

async function openArchive(archivePath: string): Promise<yauzl.ZipFile> {
  try {
    return await yauzl.openPromise(archivePath, YAUZL_OPTIONS);
  } catch (error) {
    throw malformedArchive(error);
  }
}

export async function inspectArchive(
  archivePath: string,
  limits: ArchiveLimits,
): Promise<ArchiveInspection> {
  const zip = await openArchive(archivePath);
  const state = createEntryPolicyState();
  const entries: SafeZipEntry[] = [];
  let totalUncompressedBytes = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= limits.maximumEntries) {
        throw new IntakeError("ZIP_TOO_MANY_ENTRIES", `ZIP exceeds ${limits.maximumEntries} entries.`);
      }
      const inspected = inspectEntry(entry, limits, state);
      totalUncompressedBytes += inspected.uncompressedSize;
      if (totalUncompressedBytes > limits.maximumTotalUncompressedBytes) {
        throw new IntakeError(
          "ZIP_TOTAL_TOO_LARGE",
          `ZIP exceeds ${limits.maximumTotalUncompressedBytes} total uncompressed bytes.`,
        );
      }
      entries.push(inspected);
    }
  } catch (error) {
    throw malformedArchive(error);
  } finally {
    zip.close();
  }

  return { entries, entryCount: entries.length, totalUncompressedBytes };
}

async function ensureDirectory(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new IntakeError("ZIP_UNSAFE_PATH", "Extraction path is not a safe directory.", target);
    }
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
}

async function streamEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, outputPath: string): Promise<void> {
  const input = await zip.openReadStreamPromise(entry);
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  let bytes = 0;
  input.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  await pipeline(input, output);
  if (bytes !== entry.uncompressedSize) {
    throw new IntakeError("ZIP_MALFORMED", "Extracted byte count differs from ZIP metadata.", entry.fileName);
  }
}

export async function extractArchive(
  archivePath: string,
  extractionRoot: string,
  expectedEntries: SafeZipEntry[],
  limits: ArchiveLimits,
  options: ExtractionOptions = {},
): Promise<void> {
  await mkdir(extractionRoot, { recursive: true, mode: 0o700 });
  let zip: yauzl.ZipFile;
  try {
    zip = await openArchive(archivePath);
  } catch (error) {
    await rm(extractionRoot, { recursive: true, force: true });
    throw error;
  }
  const state = createEntryPolicyState();
  let index = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      const inspected = inspectEntry(entry, limits, state);
      const expected = expectedEntries[index];
      if (
        !expected ||
        expected.normalizedPath !== inspected.normalizedPath ||
        expected.isDirectory !== inspected.isDirectory ||
        expected.uncompressedSize !== inspected.uncompressedSize
      ) {
        throw new IntakeError("ZIP_MALFORMED", "ZIP entries changed between inspection and extraction.", entry.fileName);
      }
      index += 1;

      const outputPath = resolveExtractionPath(extractionRoot, inspected);
      if (inspected.isDirectory) {
        await ensureDirectory(outputPath);
        continue;
      }

      await ensureDirectory(path.dirname(outputPath));
      await streamEntry(zip, entry, outputPath);
      await options.onFileExtracted?.(outputPath);
    }
    if (index !== expectedEntries.length) {
      throw new IntakeError("ZIP_MALFORMED", "ZIP entry count changed between inspection and extraction.");
    }
  } catch (error) {
    await rm(extractionRoot, { recursive: true, force: true });
    throw malformedArchive(error);
  } finally {
    zip.close();
  }
}
