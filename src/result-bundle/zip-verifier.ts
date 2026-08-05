// Independent ZIP verification for Phase 6 result bundles
// Uses yauzl to reopen and verify the archive.
import yauzl from "yauzl";
import crypto from "node:crypto";
import { ResultBundleError } from "./contracts.js";
import type { ManifestEntry } from "./contracts.js";
import { FIXED_FILE_MODE } from "./result-bundle-paths.js";
import { validateEntryPath } from "./deterministic-zip.js";

export interface VerificationResult {
  sha256: string;
  sizeBytes: number;
  entryCount: number;
  uncompressedBytes: number;
}

// DOS date for 1980-01-01: year=0, month=1, day=1 → (0<<9)|(1<<5)|1 = 0x0021
export const FIXED_DOS_DATE = 0x0021;
// DOS time for 00:00:00: hour=0, min=0, sec=0 → 0x0000
export const FIXED_DOS_TIME = 0x0000;

// Encryption bit in general purpose bit flag
export const GPB_ENCRYPTION_BIT = 0x0001;

/**
 * Reopen and independently verify the ZIP archive.
 * Checks: entry presence, order, sha256 checksums, timestamps, modes,
 * encryption, archive comment, path safety, no extra entries.
 */
export async function verifyResultBundleZip(
  archivePath: string
): Promise<VerificationResult> {
  return new Promise<VerificationResult>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        return reject(new ResultBundleError(
          "RESULT_ARCHIVE_VERIFY_FAILED",
          `Cannot open archive: ${openErr?.message ?? "unknown"}`
        ));
      }

      // Check archive comment must be empty
      if (zipfile.comment && zipfile.comment.length > 0) {
        zipfile.close();
        return reject(new ResultBundleError(
          "RESULT_ARCHIVE_VERIFY_FAILED",
          `Archive must have no comment; found comment of length ${zipfile.comment.length}`
        ));
      }

      const seenPaths = new Set<string>();
      const seenNormalized = new Set<string>();
      const seen: Map<string, { sha256: string; sizeBytes: number }> = new Map();
      let uncompressedBytes = 0;
      let entryCount = 0;
      let manifestBuffer: Buffer | null = null;
      let previousPath = "";

      zipfile.readEntry();

      zipfile.on("entry", (entry: yauzl.Entry) => {
        const entryPath: string = entry.fileName;

        // Path safety validation using canonical validateEntryPath
        try {
          validateEntryPath(entryPath);
        } catch (err) {
          zipfile.close();
          return reject(err instanceof ResultBundleError ? err : new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", String(err)));
        }

        // Case-fold & NFC collision check
        const normalizedKey = entryPath.normalize("NFC").toLowerCase();
        if (seenNormalized.has(normalizedKey)) {
          zipfile.close();
          return reject(new ResultBundleError("RESULT_ARCHIVE_PATH_COLLISION", `Path collision (case/NFC): '${entryPath}'`));
        }
        seenNormalized.add(normalizedKey);

        // No directory entries
        if (entryPath.endsWith("/")) {
          zipfile.close();
          return reject(new ResultBundleError(
            "RESULT_ARCHIVE_VERIFY_FAILED",
            `Unexpected directory entry: '${entryPath}'`
          ));
        }

        // Check lexical order
        if (previousPath && entryPath < previousPath) {
          zipfile.close();
          return reject(new ResultBundleError(
            "RESULT_ARCHIVE_VERIFY_FAILED",
            `Entries not in lexical order: '${entryPath}' came after '${previousPath}'`
          ));
        }
        previousPath = entryPath;

        // Check for duplicates
        if (seenPaths.has(entryPath)) {
          zipfile.close();
          return reject(new ResultBundleError(
            "RESULT_ARCHIVE_VERIFY_FAILED",
            `Duplicate entry: '${entryPath}'`
          ));
        }
        seenPaths.add(entryPath);

        // ── Canonical metadata checks ──────────────────────────────────────

        // 1. Encryption: bit 0 of general purpose bit flag must be 0
        if (entry.generalPurposeBitFlag & GPB_ENCRYPTION_BIT) {
          zipfile.close();
          return reject(new ResultBundleError(
            "RESULT_ARCHIVE_VERIFY_FAILED",
            `Encrypted entry '${entryPath}' is not allowed`
          ));
        }

        // 2. DOS timestamp must be exactly 1980-01-01 00:00:00
        if (entry.lastModFileDate !== FIXED_DOS_DATE || entry.lastModFileTime !== FIXED_DOS_TIME) {
          zipfile.close();
          return reject(new ResultBundleError(
            "RESULT_ARCHIVE_VERIFY_FAILED",
            `Entry '${entryPath}' has non-canonical timestamp (date=0x${entry.lastModFileDate.toString(16).padStart(4, "0")} time=0x${entry.lastModFileTime.toString(16).padStart(4, "0")}), expected date=0x${FIXED_DOS_DATE.toString(16).padStart(4, "0")} time=0x${FIXED_DOS_TIME.toString(16).padStart(4, "0")}`
          ));
        }

        // 3. File mode: top 16 bits of externalFileAttributes must be 0o100644
        const entryMode = entry.externalFileAttributes >>> 16;
        if (entryMode !== FIXED_FILE_MODE) {
          zipfile.close();
          return reject(new ResultBundleError(
            "RESULT_ARCHIVE_VERIFY_FAILED",
            `Entry '${entryPath}' has non-canonical mode 0o${entryMode.toString(8)}, expected 0o${FIXED_FILE_MODE.toString(8)}`
          ));
        }

        // Check for unsupported compression methods (only deflate=8 and store=0)
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          zipfile.close();
          return reject(new ResultBundleError(
            "RESULT_ARCHIVE_VERIFY_FAILED",
            `Unsupported compression method ${entry.compressionMethod} for '${entryPath}'`
          ));
        }

        // Read and hash the entry
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            zipfile.close();
            return reject(new ResultBundleError(
              "RESULT_ARCHIVE_VERIFY_FAILED",
              `Cannot read entry '${entryPath}': ${streamErr?.message ?? "unknown"}`
            ));
          }

          const hash = crypto.createHash("sha256");
          const chunks: Buffer[] = [];

          readStream.on("data", (chunk: Buffer) => {
            hash.update(chunk);
            if (entryPath === "manifest.json") {
              chunks.push(chunk);
            }
          });

          readStream.on("error", (err: Error) => {
            zipfile.close();
            reject(new ResultBundleError(
              "RESULT_ARCHIVE_VERIFY_FAILED",
              `Read error for '${entryPath}': ${err.message}`
            ));
          });

          readStream.on("end", () => {
            const entryBytes = entry.uncompressedSize;
            uncompressedBytes += entryBytes;
            entryCount += 1;

            if (entryPath === "manifest.json") {
              manifestBuffer = Buffer.concat(chunks);
            }

            seen.set(entryPath, {
              sha256: hash.digest("hex"),
              sizeBytes: entryBytes,
            });

            zipfile.readEntry();
          });
        });
      });

      zipfile.on("end", async () => {
        zipfile.close();

        try {
          if (!manifestBuffer) {
            throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Missing manifest.json");
          }
          const manifestObj = JSON.parse(manifestBuffer.toString("utf8"));
          if (!manifestObj || !Array.isArray(manifestObj.entries)) {
            throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Invalid manifest.json schema");
          }
          const expectedEntries = manifestObj.entries as ManifestEntry[];

          seen.delete("manifest.json");

          // Compare against expected entries
          if (seen.size !== expectedEntries.length) {
            throw new ResultBundleError(
              "RESULT_ARCHIVE_VERIFY_FAILED",
              `Entry count mismatch: found ${seen.size}, expected ${expectedEntries.length}`
            );
          }

          for (const expected of expectedEntries) {
            const actual = seen.get(expected.path);
            if (!actual) {
              throw new ResultBundleError(
                "RESULT_ARCHIVE_VERIFY_FAILED",
                `Missing expected entry: '${expected.path}'`
              );
            }
            if (actual.sha256 !== expected.sha256) {
              throw new ResultBundleError(
                "RESULT_ARCHIVE_VERIFY_FAILED",
                `SHA-256 mismatch for '${expected.path}': got ${actual.sha256}, expected ${expected.sha256}`
              );
            }
            if (actual.sizeBytes !== expected.size_bytes) {
              throw new ResultBundleError(
                "RESULT_ARCHIVE_VERIFY_FAILED",
                `Size mismatch for '${expected.path}': got ${actual.sizeBytes}, expected ${expected.size_bytes}`
              );
            }
          }

          // Check required entries
          const { REQUIRED_RESULT_BUNDLE_ENTRIES } = await import("./result-bundle-paths.js");
          for (const req of REQUIRED_RESULT_BUNDLE_ENTRIES) {
            if (!seenPaths.has(req)) {
              throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Missing required entry: ${req}`);
            }
          }

          // Hash the archive file itself
          const { createReadStream } = await import("node:fs");
          const { stat } = await import("node:fs/promises");
          const archiveStat = await stat(archivePath);
          const archiveHash = crypto.createHash("sha256");
          await new Promise<void>((res, rej) => {
            const s = createReadStream(archivePath);
            s.on("data", (chunk: Buffer) => archiveHash.update(chunk));
            s.on("end", () => res());
            s.on("error", rej);
          });

          resolve({
            sha256: archiveHash.digest("hex"),
            sizeBytes: archiveStat.size,
            entryCount,
            uncompressedBytes,
          });
        } catch (error) {
          reject(error instanceof ResultBundleError ? error : new ResultBundleError(
            "RESULT_ARCHIVE_VERIFY_FAILED",
            `Verification failed: ${error instanceof Error ? error.message : String(error)}`
          ));
        }
      });

      zipfile.on("error", (err: Error) => {
        const msg = err.message.toLowerCase();
        if (msg.includes("relative path") || msg.includes("absolute path")) {
          return reject(new ResultBundleError("RESULT_SOURCE_PATH_UNSAFE", `Unsafe ZIP entry path: ${err.message}`));
        }
        reject(new ResultBundleError(
          "RESULT_ARCHIVE_VERIFY_FAILED",
          `ZIP error: ${err.message}`
        ));
      });
    });
  });
}
