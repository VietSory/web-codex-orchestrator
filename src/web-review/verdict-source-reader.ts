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
 * - size limit (<= 1 MiB) before and after the read
 * - stable file identity and size across the complete read
 * - JSON parsing & canonical JSON serialization
 * - SHA-256 calculation
 */
export async function readAndCanonicalizeVerdict(
  verdictPath: string,
  maxBytes = MAXIMUM_VERDICT_FILE_BYTES
): Promise<IngestedVerdict> {
  const resolvedPath = path.resolve(verdictPath);

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

  let handle: fs.FileHandle | null = null;
  let rawBuf: Buffer;
  try {
    handle = await fs.open(resolvedPath, "r");
    const statOpened = await handle.stat();
    if (!statOpened.isFile()) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", `Verdict file handle is not a regular file: '${verdictPath}'`);
    }
    if (
      statOpened.dev !== lstatBefore.dev ||
      statOpened.ino !== lstatBefore.ino ||
      statOpened.size !== lstatBefore.size
    ) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", "Verdict file changed identity or size before read.");
    }
    if (statOpened.size > maxBytes) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", `Verdict file size exceeds limit of ${maxBytes} bytes.`);
    }

    rawBuf = await handle.readFile();

    const statAfter = await handle.stat();
    if (rawBuf.byteLength > maxBytes || statAfter.size > maxBytes) {
      throw new WebReviewError(
        "WEB_REVIEW_VERDICT_SOURCE_INVALID",
        `Verdict file grew beyond limit of ${maxBytes} bytes during read.`
      );
    }
    if (
      statAfter.dev !== statOpened.dev ||
      statAfter.ino !== statOpened.ino ||
      statAfter.size !== statOpened.size ||
      statAfter.size !== rawBuf.byteLength
    ) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", "Verdict file modified during read.");
    }

    // Ensure the path still names the same regular file after the handle read.
    const lstatAfter = await fs.lstat(resolvedPath);
    if (
      lstatAfter.isSymbolicLink() ||
      !lstatAfter.isFile() ||
      lstatAfter.dev !== statOpened.dev ||
      lstatAfter.ino !== statOpened.ino ||
      lstatAfter.size !== statOpened.size
    ) {
      throw new WebReviewError("WEB_REVIEW_VERDICT_SOURCE_INVALID", "Verdict path changed during read.");
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBuf.toString("utf8"));
  } catch (err) {
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_SOURCE_INVALID",
      `Verdict file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let canonicalBuffer: Buffer;
  try {
    canonicalBuffer = canonicalJsonBuffer(parsed);
  } catch (err) {
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_SOURCE_INVALID",
      `Failed canonicalizing verdict JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (canonicalBuffer.byteLength > maxBytes) {
    throw new WebReviewError(
      "WEB_REVIEW_VERDICT_SOURCE_INVALID",
      `Canonical verdict size (${canonicalBuffer.byteLength} bytes) exceeds limit of ${maxBytes} bytes.`
    );
  }

  return {
    canonicalBuffer,
    verdictSha256: sha256Hex(canonicalBuffer),
    parsedVerdict: parsed,
  };
}
