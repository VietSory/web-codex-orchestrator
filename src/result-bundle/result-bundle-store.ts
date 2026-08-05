// Atomic receipt read/write for Phase 6 result bundle
import fs from "node:fs";
import path from "node:path";
import { ResultBundleError } from "./contracts.js";
import type { ResultBundleReceipt, ResultBundleState } from "./contracts.js";

const RECEIPT_VERSION = "1.0";

/** Required top-level fields for a receipt */
const REQUIRED_RECEIPT_FIELDS: ReadonlyArray<keyof ResultBundleReceipt> = [
  "result_bundle_version",
  "run_id",
  "state",
  "input_digest_sha256",
  "execution_receipt_sha256",
  "git_publish_receipt_sha256",
  "draft_pr_receipt_sha256",
  "accepted_bundle_tree_sha256",
  "change_set_sha256",
  "base_commit",
  "published_commit_sha",
  "remote_branch_sha",
  "pull_request",
  "archive_relative_path",
  "archive_sha256",
  "archive_size_bytes",
  "entry_count",
  "uncompressed_size_bytes",
  "manifest_sha256",
  "warnings",
  "created_at",
  "updated_at",
  "built_at",
  "verified_at",
  "ready_at",
];

const VALID_STATES = new Set<ResultBundleState>([
  "READY_TO_BUILD", "BUILDING", "BUILT", "VERIFIED", "READY_FOR_WEB_REVIEW",
  "BLOCKED", "RETRYABLE", "FAILED",
]);

function assertReceipt(value: unknown): asserts value is ResultBundleReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Receipt must be a JSON object.");
  }
  const obj = value as Record<string, unknown>;
  for (const field of REQUIRED_RECEIPT_FIELDS) {
    if (!(field in obj)) {
      throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Receipt missing field: ${field}`);
    }
  }
  if (obj.result_bundle_version !== RECEIPT_VERSION) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `result_bundle_version must be "${RECEIPT_VERSION}".`);
  }
  if (!VALID_STATES.has(obj.state as ResultBundleState)) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Invalid state: ${String(obj.state)}`);
  }
  for (const shaField of [
    "input_digest_sha256", "execution_receipt_sha256", "git_publish_receipt_sha256",
    "draft_pr_receipt_sha256", "accepted_bundle_tree_sha256", "change_set_sha256",
    "archive_sha256", "manifest_sha256",
  ] as const) {
    const v = obj[shaField];
    if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) {
      throw new ResultBundleError("RESULT_RECEIPT_INVALID", `${shaField} must be a 64-hex SHA-256.`);
    }
  }
  for (const commitField of ["base_commit", "published_commit_sha", "remote_branch_sha"] as const) {
    const v = obj[commitField];
    if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v)) {
      throw new ResultBundleError("RESULT_RECEIPT_INVALID", `${commitField} must be a 40-hex SHA.`);
    }
  }
}

/** Read and validate a result bundle receipt. Returns null if the file does not exist. */
export async function readResultBundleReceipt(receiptPath: string): Promise<ResultBundleReceipt | null> {
  try {
    const raw = await fs.promises.readFile(receiptPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    assertReceipt(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ResultBundleError) throw error;
    throw new ResultBundleError(
      "RESULT_RECEIPT_INVALID",
      `Cannot read result bundle receipt: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Atomically write a result bundle receipt */
export async function writeResultBundleReceipt(receiptPath: string, receipt: ResultBundleReceipt): Promise<void> {
  await fs.promises.mkdir(path.dirname(receiptPath), { recursive: true });
  const tmp = `${receiptPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(receipt, null, 2) + "\n", "utf8");
    await fs.promises.rename(tmp, receiptPath);
  } catch (error) {
    // Clean up temp on failure
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw new ResultBundleError(
      "RESULT_OPERATIONAL_ERROR",
      `Failed to write result bundle receipt: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
