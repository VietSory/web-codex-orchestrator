import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { ExecutorError, type ExecutorReceipt, type ExecutorState } from "./contracts.js";
import { executorPaths, prepareExecutorDirectory } from "./paths.js";
import { readStableExecutorStateFile, writeDurableExecutorStateFile } from "./state-io.js";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 8 * 1024;
const MAX_ERRORS = 32;
const MAX_DIAGNOSTIC_CHARS = 8192;
const MAX_MODEL_TURNS = 128;
const MAX_INPUT_TOKENS = 20_000_000;
const MAX_OUTPUT_TOKENS = 4_000_000;
const MAX_REPAIR_OPERATIONS = 16;
const MAX_REPAIR_PAYLOAD_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_MODEL = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const STATES = new Set<ExecutorState>(["VALIDATING","PREPARED","APPLYING","APPLIED","VERIFYING","REVIEWING_TERRA","REVIEWING_SOL","REPAIR_APPLYING","REPAIR_APPLIED","READY_FOR_PUBLISH","ESCALATE_TO_WEB","FAILED"]);

function validDigest(value: string | null): boolean { return value === null || SHA256.test(value); }
function safeRelative(value: string): boolean { return value.length > 0 && value.length <= 4096 && !value.includes("\u0000") && !value.includes("\\") && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split("/").includes(".."); }
function selectedReview(receipt: ExecutorReceipt) { return receipt.reviewer_selection?.kind === "terra" ? receipt.terra_review : receipt.reviewer_selection?.kind === "sol" ? receipt.sol_review : null; }

function validateRepair(receipt: ExecutorReceipt, originalPaths: Set<string>): void {
  const repair = receipt.repair;
  if (!repair) {
    if (["REPAIR_APPLYING", "REPAIR_APPLIED"].includes(receipt.state)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Repair executor state has no durable repair authority.");
    return;
  }
  if (receipt.review_strategy !== "model" || !receipt.reviewer_selection || repair.reviewer !== receipt.reviewer_selection.kind || !SHA256.test(repair.source_change_set_digest) || !SHA256.test(repair.source_review_evidence_sha256) || !["PROPOSED","APPLYING","APPLIED","VERIFIED"].includes(repair.state) || !validDigest(repair.final_change_set_digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair identity/state is invalid.");
  const review = selectedReview(receipt);
  if (!review || review.verdict !== "REVISE" || review.change_set_digest !== repair.source_change_set_digest || review.evidence_sha256 !== repair.source_review_evidence_sha256) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair is not chained to the selected REVISE evidence.");
  if (!Array.isArray(repair.operations) || repair.operations.length < 1 || repair.operations.length > MAX_REPAIR_OPERATIONS) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair operation count is invalid.");
  const ids = new Set<string>(); const paths = new Set<string>(); let payloadBytes = 0;
  for (const operation of repair.operations) {
    if (!SAFE_ID.test(operation.op_id) || ids.has(operation.op_id) || !safeRelative(operation.path) || paths.has(operation.path) || !originalPaths.has(operation.path) || !["create_file","replace_file","delete_file"].includes(operation.kind) || !validDigest(operation.preimage_sha256) || !validDigest(operation.postimage_sha256) || !(operation.postimage_base64 === null || typeof operation.postimage_base64 === "string" && operation.postimage_base64.length <= 350_000)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair operation is invalid, duplicated, or widens path authority.");
    if (operation.kind === "create_file" && operation.preimage_sha256 !== null || operation.kind !== "create_file" && operation.preimage_sha256 === null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair preimage semantics are invalid.");
    if (operation.kind === "delete_file") {
      if (operation.postimage_base64 !== null || operation.postimage_sha256 !== null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Delete repair carries an impossible postimage.");
    } else {
      if (typeof operation.postimage_base64 !== "string" || typeof operation.postimage_sha256 !== "string") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Create/replace repair lacks a postimage.");
      const bytes = Buffer.from(operation.postimage_base64, "base64");
      if (bytes.toString("base64") !== operation.postimage_base64 || crypto.createHash("sha256").update(bytes).digest("hex") !== operation.postimage_sha256) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair postimage encoding/digest is invalid.");
      payloadBytes += bytes.byteLength;
    }
    ids.add(operation.op_id); paths.add(operation.path);
  }
  if (payloadBytes > MAX_REPAIR_PAYLOAD_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair payload exceeds the durable byte budget.");
  if (repair.state === "PROPOSED" && receipt.state !== `REVIEWING_${repair.reviewer.toUpperCase()}`) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Proposed repair is not at its selected review checkpoint.");
  if (repair.state === "APPLYING" && receipt.state !== "REPAIR_APPLYING") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Applying repair has inconsistent executor state.");
  if (repair.state === "APPLIED" && receipt.state !== "REPAIR_APPLIED" && receipt.state !== "VERIFYING") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Applied repair has inconsistent executor state.");
  if (repair.state === "VERIFIED" && (repair.final_change_set_digest === null || receipt.change_set_digest !== repair.final_change_set_digest || !receipt.verification.passed || receipt.verification.change_set_digest !== repair.final_change_set_digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Verified repair is not chained to deterministic verification of the final digest.");
}

function reviewReady(receipt: ExecutorReceipt, digest: string, kind: "terra" | "sol"): boolean {
  const review = kind === "terra" ? receipt.terra_review : receipt.sol_review;
  if (review.verdict === "APPROVE" && review.change_set_digest === digest) return true;
  return Boolean(receipt.repair?.state === "VERIFIED" && receipt.repair.reviewer === kind && receipt.repair.final_change_set_digest === digest && review.verdict === "REVISE" && review.change_set_digest === receipt.repair.source_change_set_digest && review.evidence_sha256 === receipt.repair.source_review_evidence_sha256);
}

function validateGateConsistency(receipt: ExecutorReceipt): void {
  const digest = receipt.change_set_digest;
  if (receipt.verification.passed && (receipt.verification.rounds < 1 || receipt.verification.change_set_digest === null || receipt.verification.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted verification approval lacks immutable evidence identity.");
  if (receipt.terra_review.verdict !== null && (receipt.terra_review.rounds < 1 || receipt.terra_review.change_set_digest === null || receipt.terra_review.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted Terra verdict lacks immutable evidence identity.");
  if (receipt.sol_review.verdict !== null && (receipt.sol_review.rounds < 1 || receipt.sol_review.change_set_digest === null || receipt.sol_review.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted Sol verdict lacks immutable evidence identity.");
  if (receipt.review_strategy === "web" && (receipt.repair !== undefined || receipt.reviewer_selection !== undefined || receipt.terra_review.rounds !== 0 || receipt.sol_review.rounds !== 0 || receipt.terra_review.verdict !== null || receipt.sol_review.verdict !== null || receipt.terra_review.change_set_digest !== null || receipt.sol_review.change_set_digest !== null || receipt.terra_review.evidence_sha256 !== null || receipt.sol_review.evidence_sha256 !== null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Web-review Harness receipt must not contain model-review/repair authority.");
  if (receipt.review_strategy === "model" && receipt.reviewer_selection === undefined) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Model-review Harness receipt is missing its frozen reviewer selection.");
  if (receipt.terra_review.verdict === "APPROVE" && (!receipt.verification.passed || digest === null || receipt.verification.change_set_digest !== digest || receipt.terra_review.change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Terra approval is not chained to an approved verification of the exact current digest.");
  if (receipt.sol_review.verdict === "APPROVE") {
    const baseValid = receipt.verification.passed && digest !== null && receipt.verification.change_set_digest === digest && receipt.sol_review.change_set_digest === digest;
    if (!baseValid) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Sol approval is not chained to approved verification of the exact current digest.");
    if (!receipt.reviewer_selection && (receipt.terra_review.verdict !== "APPROVE" || receipt.terra_review.change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Legacy Sol approval is not chained to Terra approval of the exact current digest.");
    if (receipt.reviewer_selection?.kind === "terra") throw new ExecutorError("EXECUTOR_STATE_INVALID", "A Terra-selected executor cannot persist Sol approval authority.");
  }
  if (receipt.reviewer_selection?.kind === "sol" && receipt.terra_review.verdict !== null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "A Sol-selected executor cannot persist an additional Terra review verdict.");
  if (receipt.reviewer_selection?.kind === "terra" && receipt.sol_review.verdict !== null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "A Terra-selected executor cannot persist an additional Sol review verdict.");
  if (receipt.state === "READY_FOR_PUBLISH") {
    if (digest === null || !receipt.verification.passed || receipt.verification.change_set_digest !== digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY_FOR_PUBLISH lacks exact-digest deterministic verification.");
    if (receipt.review_strategy === "web") return;
    if (receipt.reviewer_selection?.kind === "terra") { if (!reviewReady(receipt, digest, "terra")) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY_FOR_PUBLISH lacks selected Terra approval or a verified Terra adaptive repair chain."); }
    else if (receipt.reviewer_selection?.kind === "sol") { if (!reviewReady(receipt, digest, "sol")) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY_FOR_PUBLISH lacks selected Sol approval or a verified Sol adaptive repair chain."); }
    else if (receipt.terra_review.verdict !== "APPROVE" || receipt.sol_review.verdict !== "APPROVE" || receipt.terra_review.change_set_digest !== digest || receipt.sol_review.change_set_digest !== digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Legacy READY_FOR_PUBLISH lacks a complete exact-digest verification/Terra/Sol approval chain.");
  }
}

function validateReceipt(receipt: ExecutorReceipt): void {
  if (receipt.executor_version !== "1.0" || !STATES.has(receipt.state) || receipt.run_id !== `${receipt.task_id}:${receipt.task_bundle_sha256}` || !SHA256.test(receipt.task_bundle_sha256) || !SHA256.test(receipt.artifact_sha256) || !SHA256.test(receipt.registration_manifest_sha256) || !GIT_SHA.test(receipt.base_commit) || !GIT_SHA.test(receipt.base_tree_sha) || !receipt.repository_id || !receipt.base_branch || !receipt.worktree_path) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt identity/state is invalid.");
  if (receipt.review_strategy !== undefined && receipt.review_strategy !== "web" && receipt.review_strategy !== "model") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor review strategy is invalid.");
  if (!Array.isArray(receipt.operations) || receipt.operations.length > 256 || !Array.isArray(receipt.errors) || receipt.errors.length > MAX_ERRORS) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt arrays exceed their bounds.");
  if (!validDigest(receipt.change_set_digest) || !validDigest(receipt.verification.change_set_digest) || !validDigest(receipt.verification.evidence_sha256) || !validDigest(receipt.terra_review.change_set_digest) || !validDigest(receipt.terra_review.evidence_sha256) || !validDigest(receipt.sol_review.change_set_digest) || !validDigest(receipt.sol_review.evidence_sha256)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt contains an invalid digest.");
  if (!Number.isSafeInteger(receipt.verification.rounds) || receipt.verification.rounds < 0 || receipt.verification.rounds > 32 || !Number.isSafeInteger(receipt.terra_review.rounds) || receipt.terra_review.rounds < 0 || receipt.terra_review.rounds > 32 || !Number.isSafeInteger(receipt.sol_review.rounds) || receipt.sol_review.rounds < 0 || receipt.sol_review.rounds > 32) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor gate round counters are invalid.");
  if (![null,"APPROVE","REVISE","ESCALATE"].includes(receipt.terra_review.verdict) || ![null,"APPROVE","REVISE","ESCALATE"].includes(receipt.sol_review.verdict)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor review verdict is invalid.");
  if (receipt.reviewer_selection !== undefined) {
    const selected = receipt.reviewer_selection;
    if (!selected || !["terra", "sol"].includes(selected.kind) || !SAFE_MODEL.test(selected.model) || !EFFORTS.has(selected.reasoning_effort)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor reviewer selection is invalid.");
    if (selected.kind === "terra" && selected.model !== "gpt-5.6-terra" || selected.kind === "sol" && selected.model !== "gpt-5.6-sol") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor reviewer model does not match its selected reviewer kind.");
  }
  if (receipt.usage !== undefined && (!receipt.usage || typeof receipt.usage !== "object" || !Number.isSafeInteger(receipt.usage.model_turns) || receipt.usage.model_turns < 0 || receipt.usage.model_turns > MAX_MODEL_TURNS || !Number.isSafeInteger(receipt.usage.input_tokens) || receipt.usage.input_tokens < 0 || receipt.usage.input_tokens > MAX_INPUT_TOKENS || !Number.isSafeInteger(receipt.usage.output_tokens) || receipt.usage.output_tokens < 0 || receipt.usage.output_tokens > MAX_OUTPUT_TOKENS)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor usage counters are invalid or exceed trusted hard ceilings.");
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const operation of receipt.operations) {
    if (!operation.op_id || operation.op_id.length > 128 || ids.has(operation.op_id) || !operation.path || operation.path.length > 4096 || paths.has(operation.path) || !["create_file", "replace_file", "delete_file"].includes(operation.kind) || !validDigest(operation.preimage_sha256) || !validDigest(operation.postimage_sha256) || !validDigest(operation.backup_sha256) || typeof operation.applied !== "boolean" || operation.original_mode !== null && (!Number.isSafeInteger(operation.original_mode) || operation.original_mode < 0 || operation.original_mode > 0o777)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor operation identity/evidence is invalid or duplicated.");
    if (operation.backup_relative_path !== null && (operation.backup_relative_path.length > 4096 || operation.backup_relative_path.startsWith("/") || operation.backup_relative_path.includes(".."))) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor backup path is invalid.");
    ids.add(operation.op_id); paths.add(operation.path);
  }
  validateRepair(receipt, paths);
  for (const error of receipt.errors) if (!error.code || error.code.length > 128 || error.message.length > MAX_DIAGNOSTIC_CHARS || !Number.isFinite(Date.parse(error.at))) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor diagnostic is invalid or oversized.");
  if (!Number.isFinite(Date.parse(receipt.created_at)) || !Number.isFinite(Date.parse(receipt.updated_at))) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt timestamps are invalid.");
  validateGateConsistency(receipt);
}

export async function readExecutorReceipt(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): Promise<ExecutorReceipt | null> {
  const paths = executorPaths(stateDirectory, taskId, taskBundleSha256, artifactSha256); let bytes: Buffer;
  try { bytes = await readStableExecutorStateFile(paths.receipt, MAX_RECEIPT_BYTES); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt must be an object.");
  const receipt = parsed as ExecutorReceipt; validateReceipt(receipt); return receipt;
}
export async function writeExecutorReceipt(stateDirectory: string, receipt: ExecutorReceipt): Promise<void> {
  validateReceipt(receipt); const paths = executorPaths(stateDirectory, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256); await prepareExecutorDirectory(stateDirectory, paths.directory); const bytes = canonicalJsonBuffer(receipt); if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt exceeds byte cap."); await writeDurableExecutorStateFile(paths.receipt, bytes, MAX_RECEIPT_BYTES);
}
export interface ExecutorLock { nonce: string; path: string; }
export async function acquireExecutorLock(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): Promise<ExecutorLock> {
  const paths = executorPaths(stateDirectory, taskId, taskBundleSha256, artifactSha256); await prepareExecutorDirectory(stateDirectory, paths.directory); const nonce = crypto.randomBytes(24).toString("hex"); const bytes = canonicalJsonBuffer({ pid: process.pid, nonce, created_at: new Date().toISOString() }); let handle: fs.FileHandle | null = null;
  try { handle = await fs.open(paths.lock, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); } catch (error) { await handle?.close().catch(() => undefined); if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ExecutorError("EXECUTOR_LOCKED", "Executor artifact is already locked; stale locks are never auto-stolen."); throw error; }
  await handle.close(); return { nonce, path: paths.lock };
}
export async function releaseExecutorLock(lock: ExecutorLock): Promise<void> {
  let bytes: Buffer; try { bytes = await readStableExecutorStateFile(lock.path, MAX_LOCK_BYTES); } catch { return; }
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { nonce?: unknown }).nonce !== lock.nonce) return; await fs.unlink(lock.path).catch(() => undefined);
}
