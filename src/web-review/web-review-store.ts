// Atomic storage and persistence for Phase 7 per-round receipts and canonical artifacts (P0-12, P0-15)
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { WebReviewError } from "./contracts.js";
import type { WebReviewReceipt, WebReviewState } from "./contracts.js";

const RECEIPT_VERSION = "1.1";

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

async function readRegularFileNoSymlink(
  filePath: string,
  missingAllowed: boolean,
  errorCode: string
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

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new WebReviewError(errorCode, `Review artifact changed identity during open: ${filePath}`);
    }
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== buffer.byteLength) {
      throw new WebReviewError(errorCode, `Review artifact changed while being read: ${filePath}`);
    }
    return buffer;
  } catch (error) {
    if (error instanceof WebReviewError) throw error;
    throw new WebReviewError(errorCode, `Cannot read review artifact '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
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

/** Read a canonical artifact as a regular non-symlink file. */
export async function readCanonicalArtifact(filePath: string): Promise<Buffer | null> {
  return readRegularFileNoSymlink(filePath, true, "WEB_REVIEW_OPERATIONAL_ERROR");
}
