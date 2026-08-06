// Untrusted verdict source file reader and canonicalizer for Phase 7
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { WebReviewError } from "./contracts.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";

export const MAXIMUM_VERDICT_FILE_BYTES = 1_048_576; // 1 MiB limit

export interface IngestedVerdict {
  canonicalBuffer: Buffer;
  verdictSha256: string;
  parsedVerdict: unknown;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Safely read an untrusted verdict file from disk, enforcing:
 * - regular file check (no symlinks, no special files)
 * - size limit (<= 1 MiB)
 * - file identity & size stability check before and after read
 * - JSON parsing & canonical JSON serialization
 * - SHA-256 calculation
 */
export async function readAndCanonicalizeVerdict(
  verdictPath: string,
  maxBytes = MAXIMUM_VERDICT_FILE_BYTES
): Promise<IngestedVerdict> {
  const resolvedPath = path.resolve(verdictPath);

  // 1. Check lstat to reject symlinks before open
  let lstatBefore: import("node:fs").Stats;
  try {
    lstatBefore = await fs.lstat(resolvedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", `Verdict file does not exist: '${verdictPath}'`);
    }
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_SOURCE_INVALID",
      `Cannot access verdict file: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (lstatBefore.isSymbolicLink()) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", `Verdict file must not be a symbolic link: '${verdictPath}'`);
  }
  if (!lstatBefore.isFile()) {
    throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", `Verdict file must be a regular file: '${verdictPath}'`);
  }
  if (lstatBefore.size > maxBytes) {
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_SOURCE_INVALID",
      `Verdict file size (${lstatBefore.size} bytes) exceeds limit of ${maxBytes} bytes.`
    );
  }

  // 2. Open handle and read
  let handle: fs.FileHandle | null = null;
  let rawBuf: Buffer;
  try {
    handle = await fs.open(resolvedPath, "r");
    const statHandle = await handle.stat();
    if (!statHandle.isFile()) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", `Verdict file handle is not a regular file: '${verdictPath}'`);
    }
    if (statHandle.size > maxBytes) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", `Verdict file size exceeds limit of ${maxBytes} bytes.`);
    }

    rawBuf = await handle.readFile();

    // 3. Post-read stat check for stability
    const statAfter = await fs.stat(resolvedPath);
    if (
      statAfter.dev !== lstatBefore.dev ||
      statAfter.ino !== lstatBefore.ino ||
      statAfter.size !== rawBuf.length
    ) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", "Verdict file modified during read.");
    }
  } catch (err) {
    if (err instanceof WebReviewError) throw err;
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_SOURCE_INVALID",
      `Failed reading verdict file: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }

  // 4. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBuf.toString("utf8"));
  } catch (err) {
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_SOURCE_INVALID",
      `Verdict file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 5. Serialize as canonical JSON & compute SHA-256
  let canonicalBuffer: Buffer;
  try {
    canonicalBuffer = canonicalJsonBuffer(parsed);
  } catch (err) {
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_SOURCE_INVALID",
      `Failed canonicalizing verdict JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const verdictSha256 = sha256Hex(canonicalBuffer);

  return {
    canonicalBuffer,
    verdictSha256,
    parsedVerdict: parsed,
  };
}
