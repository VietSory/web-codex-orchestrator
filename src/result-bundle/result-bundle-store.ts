// Atomic receipt read/write for deterministic Result Bundles.
import fs from "node:fs";
import path from "node:path";
import { ResultBundleError } from "./contracts.js";
import type { ResultBundleReceipt, ResultBundleState } from "./contracts.js";

const REQUIRED_RECEIPT_FIELDS: ReadonlyArray<keyof ResultBundleReceipt> = [
  "result_bundle_version","run_id","state","input_digest_sha256","execution_receipt_sha256","git_publish_receipt_sha256",
  "draft_pr_receipt_sha256","accepted_bundle_tree_sha256","change_set_sha256","base_commit","published_commit_sha",
  "remote_branch_sha","pull_request","archive_relative_path","archive_sha256","archive_size_bytes","entry_count",
  "uncompressed_size_bytes","manifest_sha256","warnings","created_at","updated_at","built_at","verified_at","ready_at",
  "reviewed_entry_set_sha256",
];
const VALID_STATES = new Set<ResultBundleState>(["READY_TO_BUILD","BUILDING","BUILT","VERIFIED","READY_FOR_WEB_REVIEW","BLOCKED","RETRYABLE","FAILED"]);

function requireSha(obj: Record<string, unknown>, field: string, nullable: boolean): void {
  const value = obj[field];
  if (value === null) {
    if (nullable) return;
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `${field} cannot be null in state ${String(obj.state)}.`);
  }
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ResultBundleError("RESULT_RECEIPT_INVALID", `${field} must be a 64-hex SHA-256.`);
}
function requireCommit(obj: Record<string, unknown>, field: string, nullable = false): void {
  const value = obj[field];
  if (value === null) {
    if (nullable) return;
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `${field} cannot be null in state ${String(obj.state)}.`);
  }
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new ResultBundleError("RESULT_RECEIPT_INVALID", `${field} must be a 40-hex SHA.`);
}

export function assertResultBundleReceipt(value: unknown): asserts value is ResultBundleReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Receipt must be a JSON object.");
  const obj = value as Record<string, unknown>;
  for (const field of REQUIRED_RECEIPT_FIELDS) if (!(field in obj)) throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Receipt missing field: ${field}`);
  if (obj.result_bundle_version !== "1.1" && obj.result_bundle_version !== "1.2") throw new ResultBundleError("RESULT_RECEIPT_INVALID", "result_bundle_version must be 1.1 or 1.2.");
  if (!VALID_STATES.has(obj.state as ResultBundleState)) throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Invalid state: ${String(obj.state)}`);

  for (const field of ["input_digest_sha256","execution_receipt_sha256","git_publish_receipt_sha256","draft_pr_receipt_sha256","accepted_bundle_tree_sha256","change_set_sha256"] as const) requireSha(obj, field, false);
  for (const field of ["archive_sha256","manifest_sha256","spec_set_sha256","review_contract_sha256","review_policy_sha256","verdict_schema_sha256","revision_request_schema_sha256","reviewed_entry_set_sha256"] as const) {
    const nullable = obj.state !== "VERIFIED" && obj.state !== "READY_FOR_WEB_REVIEW";
    requireSha(obj, field, nullable);
  }
  for (const field of ["base_commit","published_commit_sha","remote_branch_sha"] as const) requireCommit(obj, field);

  if (obj.result_bundle_version === "1.2") {
    if (obj.input_kind !== "revision") throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle v1.2 input_kind must be revision.");
    if (!Number.isInteger(obj.revision_round) || Number(obj.revision_round) < 1 || Number(obj.revision_round) > 3) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Revision Result Bundle revision_round must be 1..3.");
    for (const field of ["revision_evidence_sha256","revision_request_sha256","previous_result_bundle_sha256","previous_result_receipt_sha256","previous_verdict_sha256"] as const) requireSha(obj, field, false);
    for (const field of ["previous_published_commit_sha","previous_pr_head_sha"] as const) requireCommit(obj, field);
  } else if (obj.input_kind !== undefined && obj.input_kind !== "initial") {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle v1.1 input_kind, when present, must be initial.");
  }

  if (!obj.pull_request || typeof obj.pull_request !== "object" || Array.isArray(obj.pull_request)) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "pull_request must be an object.");
  const pr = obj.pull_request as Record<string, unknown>;
  if (!Number.isInteger(pr.number) || Number(pr.number) < 1 || pr.state !== "open" || typeof pr.draft !== "boolean") throw new ResultBundleError("RESULT_RECEIPT_INVALID", "pull_request identity/state is invalid.");
  requireCommit({ head: pr.head_sha, state: obj.state }, "head");
  if (!Array.isArray(obj.warnings) || obj.warnings.length > 256 || obj.warnings.some((item) => typeof item !== "string" || item.length > 8192)) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "warnings is invalid or unbounded.");
}

export async function readResultBundleReceipt(receiptPath: string): Promise<ResultBundleReceipt | null> {
  try {
    const stat = await fs.promises.lstat(receiptPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle receipt must be a bounded regular non-symlink file.");
    const raw = await fs.promises.readFile(receiptPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    assertResultBundleReceipt(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ResultBundleError) throw error;
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Cannot read result bundle receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeResultBundleReceipt(receiptPath: string, receipt: ResultBundleReceipt): Promise<void> {
  assertResultBundleReceipt(receipt);
  await fs.promises.mkdir(path.dirname(receiptPath), { recursive: true });
  const content = Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8");
  if (content.byteLength > 2 * 1024 * 1024) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle receipt exceeds 2 MiB.");
  const tmp = `${receiptPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.promises.writeFile(tmp, content, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(tmp, receiptPath);
  } catch (error) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Failed to write result bundle receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}
