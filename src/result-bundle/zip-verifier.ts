// Independent ZIP verification for Phase 6 result bundles.
// The archive is opened once and all ZIP reads, hashing, sizing and final path
// identity checks are bound to that same stable file descriptor.
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import yauzl from "yauzl";
import crypto from "node:crypto";
import { DEFAULT_RESULT_BUNDLE_LIMITS, ResultBundleError, type ResultBundleLimits } from "./contracts.js";
import type { ManifestEntry } from "./contracts.js";
import { FIXED_FILE_MODE, REQUIRED_RESULT_BUNDLE_ENTRIES } from "./result-bundle-paths.js";
import { validateEntryPath } from "./deterministic-zip.js";
import { canonicalJsonBuffer } from "./canonical-json.js";

export interface VerificationResult {
  sha256: string;
  sizeBytes: number;
  entryCount: number;
  uncompressedBytes: number;
  reviewedEntrySetSha256: string;
}

export const FIXED_DOS_DATE = 0x0021;
export const FIXED_DOS_TIME = 0x0000;
export const GPB_ENCRYPTION_BIT = 0x0001;
const HASH_CHUNK_BYTES = 64 * 1024;

interface StableArchive {
  handle: FileHandle;
  stat: Stats;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function effectiveLimits(overrides?: Partial<ResultBundleLimits>): ResultBundleLimits {
  const limits = { ...DEFAULT_RESULT_BUNDLE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries({
    maximum_entries: limits.maximum_entries,
    maximum_entry_bytes: limits.maximum_entry_bytes,
    maximum_total_uncompressed_bytes: limits.maximum_total_uncompressed_bytes,
    maximum_archive_bytes: limits.maximum_archive_bytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ResultBundleError("RESULT_CONFIG_INVALID", `ZIP verifier limit '${name}' must be a positive safe integer.`);
    }
  }
  return limits;
}

async function openStableArchive(archivePath: string, maximumArchiveBytes: number): Promise<StableArchive> {
  let before: Stats;
  try {
    before = await lstat(archivePath);
  } catch (error) {
    throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Cannot inspect archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Result Bundle archive must be a regular non-symlink file.");
  }
  if (before.size > maximumArchiveBytes) {
    throw new ResultBundleError("RESULT_ARCHIVE_SIZE_LIMIT", `Archive size ${before.size} exceeds limit ${maximumArchiveBytes}.`);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle: FileHandle;
  try {
    handle = await open(archivePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Cannot safely open archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size > maximumArchiveBytes) {
      throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Result Bundle archive changed before stable verification began.");
    }
    return { handle, stat: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function hashStableArchive(handle: FileHandle, expected: Stats): Promise<string> {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, expected.size)));
  let offset = 0;
  while (offset < expected.size) {
    const length = Math.min(buffer.byteLength, expected.size - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead === 0) throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Result Bundle archive was truncated while hashing.");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const probe = Buffer.allocUnsafe(1);
  if ((await handle.read(probe, 0, 1, offset)).bytesRead !== 0) {
    throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Result Bundle archive grew while hashing.");
  }
  const after = await handle.stat();
  if (!sameIdentity(expected, after)) {
    throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Result Bundle archive changed while hashing.");
  }
  return hash.digest("hex");
}

async function assertArchivePathStillBound(archivePath: string, expected: Stats): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(archivePath);
  } catch (error) {
    throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Result Bundle archive path disappeared during verification: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(expected, current)) {
    throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Result Bundle archive path changed during verification.");
  }
}

/**
 * Reopen and independently verify the ZIP archive using one stable fd.
 * Limits are enforced before decompression wherever declared metadata permits,
 * so an untrusted replacement ZIP cannot turn idempotent verification into an
 * unbounded decompression or memory operation.
 */
export async function verifyResultBundleZip(
  archivePath: string,
  overrides?: Partial<ResultBundleLimits>,
): Promise<VerificationResult> {
  const limits = effectiveLimits(overrides);
  const stable = await openStableArchive(archivePath, limits.maximum_archive_bytes);
  try {
    const result = await new Promise<VerificationResult>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown, zipfile?: yauzl.ZipFile): void => {
        if (settled) return;
        settled = true;
        try { zipfile?.close(); } catch { /* best-effort close; fd is owned outside */ }
        reject(error instanceof ResultBundleError ? error : new ResultBundleError(
          "RESULT_ARCHIVE_VERIFY_FAILED",
          `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      };

      yauzl.fromFd(stable.handle.fd, {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: true,
      }, (openErr, zipfile) => {
        if (openErr || !zipfile) {
          fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Cannot open archive: ${openErr?.message ?? "unknown"}`));
          return;
        }

        if (zipfile.comment && zipfile.comment.length > 0) {
          fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Archive must have no comment; found comment of length ${zipfile.comment.length}`), zipfile);
          return;
        }
        if (zipfile.entryCount > limits.maximum_entries) {
          fail(new ResultBundleError("RESULT_ARCHIVE_ENTRY_LIMIT", `Archive declares ${zipfile.entryCount} entries, exceeding limit ${limits.maximum_entries}.`), zipfile);
          return;
        }

        const seenPaths = new Set<string>();
        const seenNormalized = new Set<string>();
        const seen = new Map<string, { sha256: string; sizeBytes: number }>();
        let uncompressedBytes = 0;
        let declaredUncompressedBytes = 0;
        let entryCount = 0;
        let manifestBuffer: Buffer | null = null;
        let previousPath = "";

        zipfile.readEntry();

        zipfile.on("entry", (entry: yauzl.Entry) => {
          if (settled) return;
          entryCount += 1;
          if (entryCount > limits.maximum_entries) {
            fail(new ResultBundleError("RESULT_ARCHIVE_ENTRY_LIMIT", `Archive contains more than ${limits.maximum_entries} entries.`), zipfile);
            return;
          }
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limits.maximum_entry_bytes) {
            fail(new ResultBundleError("RESULT_ARCHIVE_SIZE_LIMIT", `Entry '${entry.fileName}' exceeds the ${limits.maximum_entry_bytes} byte entry limit.`), zipfile);
            return;
          }
          declaredUncompressedBytes += entry.uncompressedSize;
          if (!Number.isSafeInteger(declaredUncompressedBytes) || declaredUncompressedBytes > limits.maximum_total_uncompressed_bytes) {
            fail(new ResultBundleError("RESULT_ARCHIVE_SIZE_LIMIT", `Archive uncompressed size exceeds ${limits.maximum_total_uncompressed_bytes} bytes.`), zipfile);
            return;
          }

          const entryPath = entry.fileName;
          try {
            validateEntryPath(entryPath);
          } catch (error) {
            fail(error, zipfile);
            return;
          }
          const normalizedKey = entryPath.normalize("NFC").toLowerCase();
          if (seenNormalized.has(normalizedKey)) {
            fail(new ResultBundleError("RESULT_ARCHIVE_PATH_COLLISION", `Path collision (case/NFC): '${entryPath}'`), zipfile);
            return;
          }
          seenNormalized.add(normalizedKey);
          if (entryPath.endsWith("/")) {
            fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Unexpected directory entry: '${entryPath}'`), zipfile);
            return;
          }
          if (previousPath && entryPath < previousPath) {
            fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Entries not in lexical order: '${entryPath}' came after '${previousPath}'`), zipfile);
            return;
          }
          previousPath = entryPath;
          if (seenPaths.has(entryPath)) {
            fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Duplicate entry: '${entryPath}'`), zipfile);
            return;
          }
          seenPaths.add(entryPath);

          if (entry.generalPurposeBitFlag & GPB_ENCRYPTION_BIT) {
            fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Encrypted entry '${entryPath}' is not allowed`), zipfile);
            return;
          }
          if (entry.lastModFileDate !== FIXED_DOS_DATE || entry.lastModFileTime !== FIXED_DOS_TIME) {
            fail(new ResultBundleError(
              "RESULT_ARCHIVE_VERIFY_FAILED",
              `Entry '${entryPath}' has non-canonical timestamp (date=0x${entry.lastModFileDate.toString(16).padStart(4, "0")} time=0x${entry.lastModFileTime.toString(16).padStart(4, "0")}), expected date=0x${FIXED_DOS_DATE.toString(16).padStart(4, "0")} time=0x${FIXED_DOS_TIME.toString(16).padStart(4, "0")}`,
            ), zipfile);
            return;
          }
          const entryMode = entry.externalFileAttributes >>> 16;
          if (entryMode !== FIXED_FILE_MODE) {
            fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Entry '${entryPath}' has non-canonical mode 0o${entryMode.toString(8)}, expected 0o${FIXED_FILE_MODE.toString(8)}`), zipfile);
            return;
          }
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
            fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Unsupported compression method ${entry.compressionMethod} for '${entryPath}'`), zipfile);
            return;
          }

          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (settled) return;
            if (streamErr || !readStream) {
              fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Cannot read entry '${entryPath}': ${streamErr?.message ?? "unknown"}`), zipfile);
              return;
            }
            const hash = crypto.createHash("sha256");
            const manifestChunks: Buffer[] = [];
            let actualEntryBytes = 0;
            readStream.on("data", (chunk: Buffer) => {
              if (settled) return;
              actualEntryBytes += chunk.byteLength;
              if (actualEntryBytes > entry.uncompressedSize || actualEntryBytes > limits.maximum_entry_bytes) {
                readStream.destroy(new ResultBundleError("RESULT_ARCHIVE_SIZE_LIMIT", `Entry '${entryPath}' exceeded its declared or configured size while reading.`));
                return;
              }
              hash.update(chunk);
              if (entryPath === "manifest.json") manifestChunks.push(chunk);
            });
            readStream.on("error", (error: Error) => {
              fail(error instanceof ResultBundleError ? error : new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Read error for '${entryPath}': ${error.message}`), zipfile);
            });
            readStream.on("end", () => {
              if (settled) return;
              if (actualEntryBytes !== entry.uncompressedSize) {
                fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Entry '${entryPath}' size changed while reading.`), zipfile);
                return;
              }
              uncompressedBytes += actualEntryBytes;
              if (uncompressedBytes > limits.maximum_total_uncompressed_bytes) {
                fail(new ResultBundleError("RESULT_ARCHIVE_SIZE_LIMIT", `Archive uncompressed size exceeds ${limits.maximum_total_uncompressed_bytes} bytes.`), zipfile);
                return;
              }
              if (entryPath === "manifest.json") manifestBuffer = Buffer.concat(manifestChunks, actualEntryBytes);
              seen.set(entryPath, { sha256: hash.digest("hex"), sizeBytes: actualEntryBytes });
              zipfile.readEntry();
            });
          });
        });

        zipfile.on("end", async () => {
          if (settled) return;
          try {
            zipfile.close();
            if (!manifestBuffer) throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Missing manifest.json");
            let manifestObj: unknown;
            try { manifestObj = JSON.parse(manifestBuffer.toString("utf8")); }
            catch { throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "manifest.json is not valid JSON"); }
            if (!manifestObj || typeof manifestObj !== "object" || Array.isArray(manifestObj) || !Array.isArray((manifestObj as { entries?: unknown }).entries)) {
              throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Invalid manifest.json schema");
            }
            const manifest = manifestObj as { entries: ManifestEntry[]; reviewed_entry_set_sha256?: unknown };
            if (manifest.entries.length > limits.maximum_entries) throw new ResultBundleError("RESULT_ARCHIVE_ENTRY_LIMIT", "Manifest entry list exceeds configured limit.");
            for (const expected of manifest.entries) {
              if (!expected || typeof expected.path !== "string" || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.size_bytes) || expected.size_bytes < 0 || expected.size_bytes > limits.maximum_entry_bytes) {
                throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "Manifest contains an invalid entry descriptor.");
              }
            }
            const sortedManifestEntries = [...manifest.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
            const recomputedReviewedEntrySetSha256 = crypto.createHash("sha256").update(canonicalJsonBuffer(sortedManifestEntries)).digest("hex");
            if (typeof manifest.reviewed_entry_set_sha256 !== "string" || manifest.reviewed_entry_set_sha256 !== recomputedReviewedEntrySetSha256) {
              throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", "reviewed_entry_set_sha256 mismatch in manifest.json");
            }

            seen.delete("manifest.json");
            if (seen.size !== manifest.entries.length) throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Entry count mismatch: found ${seen.size}, expected ${manifest.entries.length}`);
            for (const expected of manifest.entries) {
              const actual = seen.get(expected.path);
              if (!actual) throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Missing expected entry: '${expected.path}'`);
              if (actual.sha256 !== expected.sha256) throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `SHA-256 mismatch for '${expected.path}': got ${actual.sha256}, expected ${expected.sha256}`);
              if (actual.sizeBytes !== expected.size_bytes) throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Size mismatch for '${expected.path}': got ${actual.sizeBytes}, expected ${expected.size_bytes}`);
            }
            for (const required of REQUIRED_RESULT_BUNDLE_ENTRIES) {
              if (!seenPaths.has(required)) throw new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `Missing required entry: ${required}`);
            }

            const archiveHash = await hashStableArchive(stable.handle, stable.stat);
            await assertArchivePathStillBound(archivePath, stable.stat);
            if (settled) return;
            settled = true;
            resolve({
              sha256: archiveHash,
              sizeBytes: stable.stat.size,
              entryCount,
              uncompressedBytes,
              reviewedEntrySetSha256: recomputedReviewedEntrySetSha256,
            });
          } catch (error) {
            fail(error, zipfile);
          }
        });

        zipfile.on("error", (error: Error) => {
          const message = error.message.toLowerCase();
          if (message.includes("relative path") || message.includes("absolute path")) {
            fail(new ResultBundleError("RESULT_SOURCE_PATH_UNSAFE", `Unsafe ZIP entry path: ${error.message}`), zipfile);
            return;
          }
          fail(new ResultBundleError("RESULT_ARCHIVE_VERIFY_FAILED", `ZIP error: ${error.message}`), zipfile);
        });
      });
    });
    return result;
  } finally {
    await stable.handle.close().catch(() => undefined);
  }
}
