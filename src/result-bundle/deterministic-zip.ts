// Deterministic ZIP builder for Phase 6 result bundles
// Uses yazl. Entries sorted lexically. Fixed DOS timestamp: 1980-01-01T00:00:00Z.
// Fixed mode: 0100644. No archive comment. No directory entries.
import yazl from "yazl";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ResultBundleError } from "./contracts.js";
import type { ManifestEntry } from "./contracts.js";
import { FIXED_ZIP_TIMESTAMP, FIXED_FILE_MODE } from "./result-bundle-paths.js";

export interface ZipEntry {
  /** ZIP entry path (forward slashes, no leading slash) */
  path: string;
  /** Entry content bytes */
  content: Buffer;
}

export interface BuiltArchive {
  archivePath: string;
  sha256: string;
  sizeBytes: number;
  entries: ManifestEntry[];
  uncompressedBytes: number;
}

/** Path safety check per RESULT-BUNDLE-SCHEMA.md */
export function validateEntryPath(entryPath: string): void {
  if (!entryPath || entryPath.length === 0) {
    throw new ResultBundleError("RESULT_ARCHIVE_PATH_COLLISION", "Empty entry path.");
  }
  if (
    entryPath.startsWith("/") ||
    entryPath.startsWith("..") ||
    entryPath.includes("\\") ||
    entryPath.includes("\0") ||
    /[\x00-\x1F\x7F]/.test(entryPath) ||
    entryPath.includes("//") ||
    entryPath.split("/").some((seg) => seg === "." || seg === "..") ||
    /^[A-Za-z]:/.test(entryPath) ||
    entryPath.startsWith("\\\\")
  ) {
    throw new ResultBundleError("RESULT_SOURCE_PATH_UNSAFE", `Invalid entry path: '${entryPath}'`);
  }
  // Windows device names
  const last = entryPath.split("/").pop() ?? "";
  const baseName = last.split(".")[0]?.toUpperCase() ?? "";
  const winDevices = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4",
    "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
    "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);
  if (winDevices.has(baseName)) {
    throw new ResultBundleError("RESULT_SOURCE_PATH_UNSAFE", `Windows device name in path: '${entryPath}'`);
  }
  // Trailing dot or space
  if (last.endsWith(".") || last.endsWith(" ")) {
    throw new ResultBundleError("RESULT_SOURCE_PATH_UNSAFE", `Path segment has trailing dot/space: '${entryPath}'`);
  }
}

/**
 * Build a deterministic ZIP archive from the given entries.
 * Entries MUST be pre-sorted lexically by the caller.
 * Writes to a temp file then renames atomically.
 */
export async function buildDeterministicZip(
  entries: ZipEntry[],
  outputDir: string,
  archiveFilename: string,
  limits: { maximumEntries: number; maximumArchiveBytes: number; maximumTotalUncompressedBytes: number }
): Promise<BuiltArchive> {
  if (entries.length > limits.maximumEntries) {
    throw new ResultBundleError(
      "RESULT_ARCHIVE_ENTRY_LIMIT",
      `Too many entries: ${entries.length} > ${limits.maximumEntries}`
    );
  }

  // Validate all paths and detect collisions
  const seenNormalized = new Set<string>();
  for (const entry of entries) {
    validateEntryPath(entry.path);
    const key = entry.path.normalize("NFC").toLowerCase();
    if (seenNormalized.has(key)) {
      throw new ResultBundleError("RESULT_ARCHIVE_PATH_COLLISION", `Duplicate path: '${entry.path}'`);
    }
    seenNormalized.add(key);
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    totalUncompressed += entry.content.byteLength;
  }
  if (totalUncompressed > limits.maximumTotalUncompressedBytes) {
    throw new ResultBundleError(
      "RESULT_ARCHIVE_SIZE_LIMIT",
      `Total uncompressed size ${totalUncompressed} exceeds limit.`
    );
  }

  await fs.promises.mkdir(outputDir, { recursive: true });
  const tmpPath = path.join(outputDir, `${archiveFilename}.tmp.${process.pid}.${Date.now()}`);
  const finalPath = path.join(outputDir, archiveFilename);

  const manifestEntries: ManifestEntry[] = [];

  return new Promise<BuiltArchive>((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    const writeStream = fs.createWriteStream(tmpPath);

    zipfile.outputStream.pipe(writeStream);

    // Add entries in lexical order with fixed metadata
    for (const entry of entries) {
      const sha256 = crypto.createHash("sha256").update(entry.content).digest("hex");
      manifestEntries.push({
        path: entry.path,
        sha256,
        size_bytes: entry.content.byteLength,
      });

      zipfile.addBuffer(entry.content, entry.path, {
        mtime: FIXED_ZIP_TIMESTAMP,
        mode: FIXED_FILE_MODE,
        compress: true,
      });
    }

    zipfile.end();

    writeStream.on("error", (error) => {
      fs.unlink(tmpPath, () => undefined);
      reject(new ResultBundleError("RESULT_ARCHIVE_BUILD_FAILED", `Write error: ${error.message}`));
    });

    writeStream.on("finish", async () => {
      try {
        // Hash the archive
        const hashStream = fs.createReadStream(tmpPath);
        const hash = crypto.createHash("sha256");
        await new Promise<void>((res, rej) => {
          hashStream.on("data", (chunk: Buffer) => hash.update(chunk));
          hashStream.on("end", () => res());
          hashStream.on("error", rej);
        });
        const sha256 = hash.digest("hex");

        const stat = await fs.promises.stat(tmpPath);
        const sizeBytes = stat.size;

        if (sizeBytes > limits.maximumArchiveBytes) {
          await fs.promises.unlink(tmpPath);
          reject(new ResultBundleError(
            "RESULT_ARCHIVE_SIZE_LIMIT",
            `Archive size ${sizeBytes} exceeds limit ${limits.maximumArchiveBytes}.`
          ));
          return;
        }

        // Atomic rename
        await fs.promises.rename(tmpPath, finalPath);

        resolve({
          archivePath: finalPath,
          sha256,
          sizeBytes,
          entries: manifestEntries,
          uncompressedBytes: totalUncompressed,
        });
      } catch (error) {
        await fs.promises.unlink(tmpPath).catch(() => undefined);
        reject(
          error instanceof ResultBundleError
            ? error
            : new ResultBundleError("RESULT_ARCHIVE_BUILD_FAILED", `Post-write error: ${error instanceof Error ? error.message : String(error)}`)
        );
      }
    });
  });
}
