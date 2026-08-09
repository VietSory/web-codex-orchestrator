// Atomic receipt read/write for deterministic Result Bundles.
import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ResultBundleError } from "./contracts.js";
import type { ResultBundleReceipt, ResultBundleState } from "./contracts.js";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
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
  if ((obj.state === "VERIFIED" || obj.state === "READY_FOR_WEB_REVIEW") && pr.draft !== true) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Verified Result Bundles must remain bound to a Draft pull request.");
  requireCommit({ head: pr.head_sha, state: obj.state }, "head");
  if (!Array.isArray(obj.warnings) || obj.warnings.length > 256 || obj.warnings.some((item) => typeof item !== "string" || item.length > 8192)) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "warnings is invalid or unbounded.");
}

async function assertCanonicalReceiptParent(receiptPath: string): Promise<string> {
  const resolved = path.resolve(receiptPath);
  const parent = path.dirname(resolved);
  let info: fs.Stats;
  try {
    info = await fs.promises.lstat(parent);
  } catch (error) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Result Bundle receipt parent is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory() || await fs.promises.realpath(parent) !== parent) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle receipt parent must be a canonical real directory.");
  }
  return resolved;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openStableReceipt(resolved: string, pathStat: fs.Stats): Promise<FileHandle> {
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Cannot safely open Result Bundle receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const opened = await handle.stat();
    const current = await fs.promises.lstat(resolved);
    if (
      !opened.isFile() ||
      opened.size > MAX_RECEIPT_BYTES ||
      !sameFileIdentity(opened, pathStat) ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameFileIdentity(current, opened)
    ) {
      throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle receipt changed before bounded read.");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof ResultBundleError) throw error;
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Result Bundle receipt changed before bounded read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncParentDirectory(parent: string): Promise<void> {
  if (process.platform === "win32") return;
  let directory: FileHandle | null = null;
  try {
    directory = await fs.promises.open(parent, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS") return;
    throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

export async function readResultBundleReceipt(receiptPath: string): Promise<ResultBundleReceipt | null> {
  const resolved = path.resolve(receiptPath);
  const parent = path.dirname(resolved);
  try {
    await fs.promises.lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Cannot inspect Result Bundle receipt parent: ${error instanceof Error ? error.message : String(error)}`);
  }
  await assertCanonicalReceiptParent(resolved);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Cannot inspect Result Bundle receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECEIPT_BYTES) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle receipt must be a bounded regular non-symlink file.");

  try {
    const handle = await openStableReceipt(resolved, stat);
    try {
      const before = await handle.stat();
      const raw = await handle.readFile();
      if (raw.byteLength !== before.size) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle receipt changed while being read.");
      const after = await handle.stat();
      const pathAfter = await fs.promises.lstat(resolved);
      if (
        !sameFileIdentity(after, before) ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        pathAfter.isSymbolicLink() ||
        !pathAfter.isFile() ||
        !sameFileIdentity(pathAfter, before) ||
        pathAfter.size !== before.size
      ) {
        throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle receipt changed while being read.");
      }
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      assertResultBundleReceipt(parsed);
      return parsed;
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof ResultBundleError) throw error;
    throw new ResultBundleError("RESULT_RECEIPT_INVALID", `Cannot stably read Result Bundle receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeResultBundleReceipt(receiptPath: string, receipt: ResultBundleReceipt): Promise<void> {
  assertResultBundleReceipt(receipt);
  const resolved = path.resolve(receiptPath);
  const parent = path.dirname(resolved);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertCanonicalReceiptParent(resolved);
  const content = Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8");
  if (content.byteLength > MAX_RECEIPT_BYTES) throw new ResultBundleError("RESULT_RECEIPT_INVALID", "Result Bundle receipt exceeds 2 MiB.");
  const tmp = `${resolved}.tmp.${process.pid}.${crypto.randomUUID()}`;
  let handle: FileHandle | null = null;
  try {
    handle = await fs.promises.open(tmp, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmp, resolved);
    const finalStat = await fs.promises.lstat(resolved);
    if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.size !== content.byteLength) throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", "Result Bundle receipt replacement did not produce the exact regular file.");
    await syncParentDirectory(parent);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.unlink(tmp).catch(() => undefined);
    if (error instanceof ResultBundleError) throw error;
    throw new ResultBundleError("RESULT_OPERATIONAL_ERROR", `Failed to write result bundle receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}
