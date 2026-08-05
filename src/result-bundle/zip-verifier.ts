// Independent ZIP verification for Phase 6 result bundles
// Uses yauzl to reopen and verify the archive.
import yauzl from "yauzl";
import crypto from "node:crypto";
import { ResultBundleError } from "./contracts.js";
import type { ManifestEntry } from "./contracts.js";
import { FIXED_ZIP_TIMESTAMP, FIXED_FILE_MODE } from "./result-bundle-paths.js";

export interface VerificationResult {
  sha256: string;
  sizeBytes: number;
  entryCount: number;
  uncompressedBytes: number;
}

/**
 * Reopen and independently verify the ZIP archive.
 * Checks: entry presence, order, sha256 checksums, timestamps, modes, no extra entries.
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

      const seenPaths = new Set<string>();
      const seen: Map<string, { sha256: string; sizeBytes: number }> = new Map();
      let uncompressedBytes = 0;
      let entryCount = 0;
      let manifestBuffer: Buffer | null = null;
      let previousPath = "";

      zipfile.readEntry();

      zipfile.on("entry", (entry: yauzl.Entry) => {
        const entryPath: string = entry.fileName;

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
        reject(new ResultBundleError(
          "RESULT_ARCHIVE_VERIFY_FAILED",
          `ZIP error: ${err.message}`
        ));
      });
    });
  });
}
