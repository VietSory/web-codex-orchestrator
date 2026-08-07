// Atomic storage and persistence for Phase 7 per-round receipts and canonical artifacts (P0-12, P0-15)
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { WebReviewError } from "./contracts.js";
import type { WebReviewReceipt, WebReviewState } from "./contracts.js";

const RECEIPT_VERSION = "1.1";
export const MAX_REVIEW_STATE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_RECEIPT_ERRORS = 32;
export const MAX_RECEIPT_WARNINGS = 64;
export const MAX_RECEIPT_DIAGNOSTIC_CHARS = 8192;

const REQUIRED_RECEIPT_FIELDS: ReadonlyArray<keyof WebReviewReceipt> = [
  "phase_version",
  "run_id",
  "review_mode",
  "review_round",
  "state",
  "phase6_receipt_sha256",
  "result_bundle_sha256",
  "manifest_sha256",
  "reviewed_entry_set_sha256",
  "spec_set_sha256",
  "verdict_sha256",
  "published_commit_sha",
  "pull_request_number",
  "observed_head_sha",
  "fresh_attested_head_sha",
  "fresh_attested_base_branch",
  "previous_result_bundle_sha256",
  "previous_verdict_sha256",
  "previous_published_commit_sha",
  "previous_pr_head_sha",
  "revision_request_sha256",
  "decision_event_sha256",
  "action",
  "artifact_paths",
  "warnings",
  "errors",
  "created_at",
  "updated_at",
  "validated_at",
  "completed_at",
];

const VALID_STATES = new Set<WebReviewState>([
  "READY_TO_VALIDATE",
  "VALIDATING",
  "VALIDATED",
  "APPROVED",
  "REVISION_REQUESTED",
  "ESCALATED",
  "BLOCKED",
  "RETRYABLE",
  "FAILED",
]);

async function assertSafeParentDirectory(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  const stat = await fs.lstat(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WebReviewError("WEB_REVIEW_OPERATIONAL_ERROR", `Review artifact parent is not a safe directory: ${parent}`);
  }
}

async function readExactlyAttestedSize(
  handle: fs.FileHandle,
  expectedSize: number,
  errorCode: string,
  filePath: string
): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(buffer, offset, expectedSize - offset, offset);
    if (bytesRead === 0) {
      throw new WebReviewError(errorCode, `Review artifact was truncated during read: ${filePath}`);
    }
    offset += bytesRead;
  }
  const probe = Buffer.alloc(1);
  const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, expectedSize);
  if (extraBytes !== 0) {
    throw new WebReviewError(errorCode, `Review artifact grew during read: ${filePath}`);
  }
  return buffer;
}

async function readRegularFileNoSymlink(
  filePath: string,
  missingAllowed: boolean,
  errorCode: string,
  maxBytes = MAX_REVIEW_STATE_FILE_BYTES
): Promise<Buffer | null> {
  let before: import("node:fs").Stats;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WebReviewError(errorCode, `Cannot inspect review artifact '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  }

  if (before.isSymbolicLink() || !before.isFile()) {
    throw new WebReviewError(errorCode, `Review artifact must be a regular non-symlink file: ${filePath}`);
  }
  if (before.size > maxBytes) {
    throw new WebReviewError(errorCode, `Review artifact '${filePath}' exceeds ${maxBytes} bytes.`);
  }

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new WebReviewError(errorCode, `Review artifact changed identity or metadata during open: ${filePath}`);
    }
    if (opened.size > maxBytes) {
      throw new WebReviewError(errorCode, `Review artifact '${filePath}' exceeds ${maxBytes} bytes.`);
    }

    const buffer = await readExactlyAttestedSize(handle, opened.size, errorCode, filePath);
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new WebReviewError(errorCode, `Review artifact changed while being read: ${filePath}`);
    }

    const pathAfter = await fs.lstat(filePath);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size ||
      pathAfter.mtimeMs !== opened.mtimeMs ||
      pathAfter.ctimeMs !== opened.ctimeMs
    ) {
      throw new WebReviewError(errorCode, `Review artifact path changed while being read: ${filePath}`);
    }
    return buffer;
  } catch (error) {
    if (error instanceof WebReviewError) throw error;
    throw new WebReviewError(errorCode, `Cannot read review artifact '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function assertBoundedStringArray(value: unknown, label: string, maximumItems: number): void {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `${label} must be an array with at most ${maximumItems} entries.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > MAX_RECEIPT_DIAGNOSTIC_CHARS) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `${label} contains an invalid or oversized entry.`);
    }
  }
}

export function assertWebReviewReceipt(value: unknown): asserts value is WebReviewReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "Receipt must be a JSON object.");
  }
  const obj = value as Record<string, unknown>;

  for (const field of REQUIRED_RECEIPT_FIELDS) {
    if (!(field in obj)) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `Receipt missing field: ${field}`);
    }
  }

  if (obj.phase_version !== RECEIPT_VERSION) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `phase_version must be "${RECEIPT_VERSION}".`);
  }
  if (!VALID_STATES.has(obj.state as WebReviewState)) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `Invalid state: ${String(obj.state)}`);
  }
  if (!Number.isInteger(obj.review_round) || (obj.review_round as number) < 1 || (obj.review_round as number) > 4) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "review_round must be an integer between 1 and 4.");
  }
  if (obj.review_mode !== "INITIAL" && obj.review_mode !== "REVISION") {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "review_mode must be INITIAL or REVISION.");
  }
  if (typeof obj.run_id !== "string" || obj.run_id.length === 0 || obj.run_id.length > 256) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "run_id is missing or oversized.");
  }

  for (const shaField of [
    "phase6_receipt_sha256",
    "result_bundle_sha256",
    "manifest_sha256",
    "reviewed_entry_set_sha256",
    "spec_set_sha256",
  ] as const) {
    const v = obj[shaField];
    if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `${shaField} must be a 64-hex SHA-256.`);
    }
  }

  for (const optShaField of [
    "verdict_sha256",
    "previous_result_bundle_sha256",
    "previous_verdict_sha256",
    "revision_request_sha256",
    "decision_event_sha256",
  ] as const) {
    const v = obj[optShaField];
    if (v !== null && (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `${optShaField} must be null or a 64-hex SHA-256.`);
    }
  }

  for (const commitField of ["published_commit_sha", "observed_head_sha"] as const) {
    const v = obj[commitField];
    if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v)) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `${commitField} must be a 40-hex SHA.`);
    }
  }
  if (obj.fresh_attested_head_sha !== null && (typeof obj.fresh_attested_head_sha !== "string" || !/^[a-f0-9]{40}$/.test(obj.fresh_attested_head_sha))) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "fresh_attested_head_sha must be null or a 40-hex SHA.");
  }

  assertBoundedStringArray(obj.warnings, "warnings", MAX_RECEIPT_WARNINGS);
  if (!Array.isArray(obj.errors) || obj.errors.length > MAX_RECEIPT_ERRORS) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `errors must contain at most ${MAX_RECEIPT_ERRORS} entries.`);
  }
  for (const errorEntry of obj.errors) {
    if (typeof errorEntry !== "object" || errorEntry === null || Array.isArray(errorEntry)) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "errors contains a non-object entry.");
    }
    const entry = errorEntry as Record<string, unknown>;
    if (typeof entry.code !== "string" || entry.code.length === 0 || entry.code.length > 256) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "errors contains an invalid code.");
    }
    if (typeof entry.message !== "string" || entry.message.length > MAX_RECEIPT_DIAGNOSTIC_CHARS) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "errors contains an invalid or oversized message.");
    }
  }

  if (typeof obj.artifact_paths !== "object" || obj.artifact_paths === null || Array.isArray(obj.artifact_paths)) {
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "artifact_paths must be an object.");
  }
  for (const key of ["verdict", "receipt", "decision_event", "revision_request", "lock"] as const) {
    const pathValue = (obj.artifact_paths as Record<string, unknown>)[key];
    if (pathValue !== null && (typeof pathValue !== "string" || pathValue.length > 2048)) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `artifact_paths.${key} is invalid or oversized.`);
    }
  }

  if (obj.state === "APPROVED") {
    if (obj.action !== "ASK_USER_TO_MERGE") {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "APPROVED receipt action must be ASK_USER_TO_MERGE");
    }
    if (obj.revision_request_sha256 !== null) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "APPROVED receipt must not have revision_request_sha256");
    }
  } else if (obj.state === "REVISION_REQUESTED") {
    if (obj.action !== "NO_USER_MERGE_PROMPT") {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "REVISION_REQUESTED receipt action must be NO_USER_MERGE_PROMPT");
    }
    if (!obj.revision_request_sha256) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "REVISION_REQUESTED receipt must have revision_request_sha256");
    }
  } else if (obj.state === "ESCALATED") {
    if (obj.action !== "NOTIFY_USER_EXCEPTION") {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "ESCALATED receipt action must be NOTIFY_USER_EXCEPTION");
    }
    if (obj.revision_request_sha256 !== null) {
      throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", "ESCALATED receipt must not have revision_request_sha256");
    }
  }
}

/** Read and validate a Web review receipt. Returns null if receipt file does not exist. */
export async function readWebReviewReceipt(receiptPath: string): Promise<WebReviewReceipt | null> {
  const buffer = await readRegularFileNoSymlink(receiptPath, true, "WEB_REVIEW_RECEIPT_INVALID");
  if (!buffer) return null;
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    assertWebReviewReceipt(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof WebReviewError) throw error;
    throw new WebReviewError("WEB_REVIEW_RECEIPT_INVALID", `Cannot parse web review receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Atomically replace the mutable per-round receipt inside an already-safe directory. */
export async function writeWebReviewReceipt(receiptPath: string, receipt: WebReviewReceipt): Promise<void> {
  assertWebReviewReceipt(receipt);
  await assertSafeParentDirectory(receiptPath);

  const contentBuffer = Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8");
  if (contentBuffer.byteLength > MAX_REVIEW_STATE_FILE_BYTES) {
    throw new WebReviewError("WEB_REVIEW_OPERATIONAL_ERROR", `Web review receipt exceeds ${MAX_REVIEW_STATE_FILE_BYTES} bytes.`);
  }
  const tmp = `${receiptPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.writeFile(tmp, contentBuffer, { flag: "wx" });
    await fs.rename(tmp, receiptPath);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw new WebReviewError(
      "WEB_REVIEW_OPERATIONAL_ERROR",
      `Failed to write web review receipt at ${receiptPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Create-only canonical artifact with exact compare-and-adopt idempotency. */
export async function writeCanonicalArtifact(filePath: string, contentBuffer: Buffer): Promise<void> {
  if (contentBuffer.byteLength > MAX_REVIEW_STATE_FILE_BYTES) {
    throw new WebReviewError("WEB_REVIEW_OPERATIONAL_ERROR", `Canonical review artifact exceeds ${MAX_REVIEW_STATE_FILE_BYTES} bytes.`);
  }
  await assertSafeParentDirectory(filePath);
  try {
    await fs.writeFile(filePath, contentBuffer, { flag: "wx" });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await readRegularFileNoSymlink(filePath, false, "WEB_REVIEW_ALREADY_SEALED");
      if (existing?.equals(contentBuffer)) return;
      throw new WebReviewError(
        "WEB_REVIEW_ALREADY_SEALED",
        `Artifact already exists with different or unsafe content at '${filePath}'. Overwrite forbidden.`
      );
    }
    throw new WebReviewError(
      "WEB_REVIEW_OPERATIONAL_ERROR",
      `Failed to write canonical artifact at ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Read a canonical artifact as a bounded regular non-symlink file. */
export async function readCanonicalArtifact(filePath: string): Promise<Buffer | null> {
  return readRegularFileNoSymlink(filePath, true, "WEB_REVIEW_OPERATIONAL_ERROR");
}
