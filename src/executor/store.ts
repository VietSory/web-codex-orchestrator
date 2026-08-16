import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { readStableFile, sameStableFileIdentity, type StableFileIdentity } from "../shared/stable-file.js";
import { acquireTicketFileLock, TicketFileLockError } from "../shared/ticket-file-lock.js";
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
const MAX_REPAIR_GENERATIONS = 4;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_MODEL = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const STATES = new Set<ExecutorState>(["VALIDATING","PREPARED","APPLYING","APPLIED","VERIFYING","REVIEWING_WEB","REVIEWING_TERRA","REVIEWING_SOL","REPAIR_APPLYING","REPAIR_APPLIED","READY_FOR_PUBLISH","ESCALATE_TO_WEB","FAILED"]);

function validDigest(value: string | null): boolean { return value === null || SHA256.test(value); }
function safeRelative(value: string): boolean { return value.length > 0 && value.length <= 4096 && !value.includes("\u0000") && !value.includes("\\") && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split("/").includes(".."); }
function selectedReview(receipt: ExecutorReceipt) { return receipt.reviewer_selection?.kind === "terra" ? receipt.terra_review : receipt.reviewer_selection?.kind === "sol" ? receipt.sol_review : null; }

function validateRepairHistory(receipt: ExecutorReceipt): void {
  const history = receipt.repair_history;
  if (history === undefined) return;
  if (!Array.isArray(history) || history.length > MAX_REPAIR_GENERATIONS) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair history exceeds its bounded generation budget.");
  const evidence = new Set<string>();
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index]!;
    if (entry.generation !== index + 1 || !["web","terra","sol"].includes(entry.reviewer) || !SHA256.test(entry.source_change_set_digest) || !SHA256.test(entry.source_review_evidence_sha256) || !SHA256.test(entry.operations_sha256) || !SHA256.test(entry.final_change_set_digest) || !Number.isSafeInteger(entry.operation_count) || entry.operation_count < 1 || entry.operation_count > MAX_REPAIR_OPERATIONS || !Number.isFinite(Date.parse(entry.verified_at)) || evidence.has(entry.source_review_evidence_sha256)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair history contains invalid, duplicate, or out-of-order evidence.");
    if (index > 0 && history[index - 1]!.final_change_set_digest !== entry.source_change_set_digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair history digest chain is broken.");
    if (receipt.review_strategy === "web") {
      if (entry.reviewer !== "web") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Web-review Harness history cannot contain model repair authority.");
    } else if (receipt.review_strategy === "model") {
      const selected = receipt.reviewer_selection;
      const review = selectedReview(receipt);
      if (!selected || !review) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Model-review Harness history is missing selected reviewer authority.");
      if (index === 0 && entry.reviewer === selected.kind) {
        if (review.verdict !== "REVISE" || review.change_set_digest !== entry.source_change_set_digest || review.evidence_sha256 !== entry.source_review_evidence_sha256) throw new ExecutorError("EXECUTOR_STATE_INVALID", "First model repair generation is not chained to the selected REVISE evidence.");
      } else {
        if (entry.reviewer !== "web") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Only the selected reviewer may own the first model repair generation; later generations must be Web-owned.");
        if (index === 0 && (review.verdict !== "APPROVE" || review.change_set_digest !== entry.source_change_set_digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "First Web repair generation is not chained to the selected APPROVE digest.");
      }
    } else if (history.length > 0) {
      throw new ExecutorError("EXECUTOR_STATE_INVALID", "Repair history requires an explicit review strategy.");
    }
    evidence.add(entry.source_review_evidence_sha256);
  }
  const latest = history.at(-1);
  if (latest && receipt.repair && receipt.repair.source_change_set_digest !== latest.final_change_set_digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Current repair does not continue the immutable history digest chain.");
  if (latest && !receipt.repair && receipt.change_set_digest !== latest.final_change_set_digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor current digest no longer matches the last completed repair generation.");
}

function webRepairBoundToAuthority(receipt: ExecutorReceipt): boolean {
  const repair = receipt.repair;
  if (!repair || repair.reviewer !== "web") return false;
  if (receipt.review_strategy === "web") return receipt.reviewer_selection === undefined;
  if (receipt.review_strategy !== "model" || !receipt.reviewer_selection) return false;
  const previous = receipt.repair_history?.at(-1);
  if (previous) return previous.final_change_set_digest === repair.source_change_set_digest;
  const review = selectedReview(receipt);
  return Boolean(review?.verdict === "APPROVE" && review.change_set_digest === repair.source_change_set_digest);
}

function validateRepair(receipt: ExecutorReceipt, originalPaths: Set<string>): void {
  validateRepairHistory(receipt);
  const repair = receipt.repair;
  if (!repair) { if (["REVIEWING_WEB", "REPAIR_APPLYING", "REPAIR_APPLIED"].includes(receipt.state)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Repair executor state has no durable repair authority."); return; }
  if (!SHA256.test(repair.source_change_set_digest) || !SHA256.test(repair.source_review_evidence_sha256) || !["PROPOSED","APPLYING","APPLIED","VERIFIED"].includes(repair.state) || !validDigest(repair.final_change_set_digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair identity/state is invalid.");
  if (repair.reviewer === "web") { if (!webRepairBoundToAuthority(receipt)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Web repair is not bound to the frozen Harness authority chain."); }
  else {
    if (receipt.review_strategy !== "model" || !receipt.reviewer_selection || repair.reviewer !== receipt.reviewer_selection.kind || (receipt.repair_history?.length ?? 0) !== 0) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Model repair is not bound as the first selected-reviewer repair generation.");
    const review = selectedReview(receipt);
    if (!review || review.verdict !== "REVISE" || review.change_set_digest !== repair.source_change_set_digest || review.evidence_sha256 !== repair.source_review_evidence_sha256) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair is not chained to the selected REVISE evidence.");
  }
  if (!Array.isArray(repair.operations) || repair.operations.length < 1 || repair.operations.length > MAX_REPAIR_OPERATIONS) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair operation count is invalid.");
  const ids = new Set<string>(); const repairPaths = new Set<string>(); let payloadBytes = 0;
  for (const operation of repair.operations) {
    if (!SAFE_ID.test(operation.op_id) || ids.has(operation.op_id) || !safeRelative(operation.path) || repairPaths.has(operation.path) || !originalPaths.has(operation.path) || !["create_file","replace_file","delete_file"].includes(operation.kind) || !validDigest(operation.preimage_sha256) || !validDigest(operation.postimage_sha256) || !(operation.postimage_base64 === null || typeof operation.postimage_base64 === "string" && operation.postimage_base64.length <= 350_000)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair operation is invalid, duplicated, or widens path authority.");
    if (operation.kind === "create_file" && operation.preimage_sha256 !== null || operation.kind !== "create_file" && operation.preimage_sha256 === null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair preimage semantics are invalid.");
    if (operation.kind === "delete_file") { if (operation.postimage_base64 !== null || operation.postimage_sha256 !== null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Delete repair carries an impossible postimage."); }
    else {
      if (typeof operation.postimage_base64 !== "string" || typeof operation.postimage_sha256 !== "string") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Create/replace repair lacks a postimage.");
      const bytes = Buffer.from(operation.postimage_base64, "base64");
      if (bytes.toString("base64") !== operation.postimage_base64 || crypto.createHash("sha256").update(bytes).digest("hex") !== operation.postimage_sha256) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair postimage encoding/digest is invalid.");
      payloadBytes += bytes.byteLength;
    }
    ids.add(operation.op_id); repairPaths.add(operation.path);
  }
  if (payloadBytes > MAX_REPAIR_PAYLOAD_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair payload exceeds the durable byte budget.");
  if (repair.preimage_backups !== undefined) {
    if (!Array.isArray(repair.preimage_backups) || repair.preimage_backups.length > repair.operations.length) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair rollback backup set is invalid.");
    const backupPaths = new Set<string>();
    for (const backup of repair.preimage_backups) {
      const operation = repair.operations.find((candidate) => candidate.path === backup.path);
      if (!operation || operation.kind === "create_file" || backupPaths.has(backup.path) || backup.sha256 !== operation.preimage_sha256 || !SHA256.test(backup.sha256) || !safeRelative(backup.relative_path) || !backup.relative_path.startsWith("backups/repairs/") || !Number.isSafeInteger(backup.mode) || backup.mode < 0 || backup.mode > 0o777) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor repair rollback backup authority is invalid or duplicated.");
      backupPaths.add(backup.path);
    }
  }
  const terminal = receipt.state === "ESCALATE_TO_WEB" || receipt.state === "FAILED";
  if (!terminal) {
    const proposedState = repair.reviewer === "web" ? "REVIEWING_WEB" : `REVIEWING_${repair.reviewer.toUpperCase()}`;
    if (repair.state === "PROPOSED" && receipt.state !== proposedState) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Proposed repair is not at its review checkpoint.");
    if (repair.state === "APPLYING" && receipt.state !== "REPAIR_APPLYING") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Applying repair has inconsistent executor state.");
    if (repair.state === "APPLIED" && receipt.state !== "REPAIR_APPLIED" && receipt.state !== "VERIFYING") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Applied repair has inconsistent executor state.");
  }
  if (repair.state === "VERIFIED" && (repair.final_change_set_digest === null || receipt.change_set_digest !== repair.final_change_set_digest || !receipt.verification.passed || receipt.verification.change_set_digest !== repair.final_change_set_digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Verified repair is not chained to deterministic verification of the final digest.");
}

function selectedModelAuthorityCoversDigest(receipt: ExecutorReceipt, digest: string, kind: "terra" | "sol"): boolean {
  const review = kind === "terra" ? receipt.terra_review : receipt.sol_review;
  if (review.verdict === "APPROVE" && review.change_set_digest === digest) return true;
  if (receipt.repair?.state === "VERIFIED" && receipt.repair.reviewer === kind && receipt.repair.final_change_set_digest === digest && review.verdict === "REVISE" && review.change_set_digest === receipt.repair.source_change_set_digest && review.evidence_sha256 === receipt.repair.source_review_evidence_sha256) return true;
  if (receipt.repair?.state === "VERIFIED" && receipt.repair.reviewer === "web" && receipt.repair.final_change_set_digest === digest) {
    const history = receipt.repair_history ?? [];
    const previous = history.at(-1);
    if (previous) return previous.final_change_set_digest === receipt.repair.source_change_set_digest;
    return review.verdict === "APPROVE" && review.change_set_digest === receipt.repair.source_change_set_digest;
  }
  const history = receipt.repair_history;
  if (!history?.length || history.at(-1)!.final_change_set_digest !== digest) return false;
  const first = history[0]!;
  if (first.reviewer === kind) return review.verdict === "REVISE" && review.change_set_digest === first.source_change_set_digest && review.evidence_sha256 === first.source_review_evidence_sha256;
  return first.reviewer === "web" && review.verdict === "APPROVE" && review.change_set_digest === first.source_change_set_digest;
}

function validateGateConsistency(receipt: ExecutorReceipt): void {
  const digest = receipt.change_set_digest;
  if (receipt.verification.passed && (receipt.verification.rounds < 1 || receipt.verification.change_set_digest === null || receipt.verification.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted verification approval lacks immutable evidence identity.");
  if (receipt.terra_review.verdict !== null && (receipt.terra_review.rounds < 1 || receipt.terra_review.change_set_digest === null || receipt.terra_review.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted Terra verdict lacks immutable evidence identity.");
  if (receipt.sol_review.verdict !== null && (receipt.sol_review.rounds < 1 || receipt.sol_review.change_set_digest === null || receipt.sol_review.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted Sol verdict lacks immutable evidence identity.");
  if (receipt.review_strategy === "web") {
    if (receipt.reviewer_selection !== undefined || receipt.terra_review.rounds !== 0 || receipt.sol_review.rounds !== 0 || receipt.terra_review.verdict !== null || receipt.sol_review.verdict !== null || receipt.terra_review.change_set_digest !== null || receipt.sol_review.change_set_digest !== null || receipt.terra_review.evidence_sha256 !== null || receipt.sol_review.evidence_sha256 !== null || receipt.repair !== undefined && receipt.repair.reviewer !== "web") throw new ExecutorError("EXECUTOR_STATE_INVALID", "Web-review Harness receipt contains model-review authority.");
  }
  if (receipt.review_strategy === "model" && receipt.reviewer_selection === undefined) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Model-review Harness receipt is missing its frozen reviewer selection.");
  if (receipt.terra_review.verdict === "APPROVE" && receipt.reviewer_selection?.kind !== "terra" && (!receipt.verification.passed || digest === null || receipt.verification.change_set_digest !== digest || receipt.terra_review.change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Terra approval is not chained to an approved verification of the exact current digest.");
  if (receipt.sol_review.verdict === "APPROVE" && receipt.reviewer_selection?.kind !== "sol") {
    const baseValid = receipt.verification.passed && digest !== null && receipt.verification.change_set_digest === digest && receipt.sol_review.change_set_digest === digest;
    if (!baseValid) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Sol approval is not chained to approved verification of the exact current digest.");
    if (!receipt.reviewer_selection && (receipt.terra_review.verdict !== "APPROVE" || receipt.terra_review.change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Legacy Sol approval is not chained to Terra approval of the exact current digest.");
  }
  if (receipt.reviewer_selection?.kind === "sol" && receipt.terra_review.verdict !== null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "A Sol-selected executor cannot persist an additional Terra review verdict.");
  if (receipt.reviewer_selection?.kind === "terra" && receipt.sol_review.verdict !== null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "A Terra-selected executor cannot persist an additional Sol review verdict.");
  if (receipt.state === "READY_FOR_PUBLISH") {
    if (digest === null || !receipt.verification.passed || receipt.verification.change_set_digest !== digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY_FOR_PUBLISH lacks exact-digest deterministic verification.");
    if (receipt.review_strategy === "web") {
      if (receipt.repair && (receipt.repair.reviewer !== "web" || receipt.repair.state !== "VERIFIED" || receipt.repair.final_change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY_FOR_PUBLISH has an unverified or stale Web repair.");
      return;
    }
    if (receipt.reviewer_selection?.kind === "terra") { if (!selectedModelAuthorityCoversDigest(receipt, digest, "terra")) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY_FOR_PUBLISH lacks selected Terra approval or a valid downstream Harness repair chain."); }
    else if (receipt.reviewer_selection?.kind === "sol") { if (!selectedModelAuthorityCoversDigest(receipt, digest, "sol")) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY_FOR_PUBLISH lacks selected Sol approval or a valid downstream Harness repair chain."); }
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
export async function writeExecutorReceipt(stateDirectory: string, receipt: ExecutorReceipt): Promise<void> { validateReceipt(receipt); const paths = executorPaths(stateDirectory, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256); await prepareExecutorDirectory(stateDirectory, paths.directory); const bytes = canonicalJsonBuffer(receipt); if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt exceeds byte cap."); await writeDurableExecutorStateFile(paths.receipt, bytes, MAX_RECEIPT_BYTES); }

interface ExecutorLockRecord { pid: number; nonce: string; created_at: string; }
interface ExecutorLockObservation { state: "LIVE" | "STALE"; record: ExecutorLockRecord; identity: StableFileIdentity; }
type ExecutorLockInspection = { state: "MISSING" | "MALFORMED" } | ExecutorLockObservation;
export interface ExecutorLock { nonce: string; path: string; identity: StableFileIdentity; }

function executorStableIdentity(stats: Stats): StableFileIdentity { return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs }; }
function sameExecutorInode(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.size === right.size; }
function executorProcessIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
function parseExecutorLock(bytes: Buffer): ExecutorLockRecord | null {
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Partial<ExecutorLockRecord>;
  if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.nonce !== "string" || !/^[a-f0-9]{48}$/.test(value.nonce) || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) return null;
  return value as ExecutorLockRecord;
}
async function inspectExecutorLock(lockPath: string): Promise<ExecutorLockInspection> {
  const info = await fs.lstat(lockPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (!info) return { state: "MISSING" };
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_LOCK_BYTES) return { state: "MALFORMED" };
  try {
    const snapshot = await readStableFile(lockPath, MAX_LOCK_BYTES);
    const record = parseExecutorLock(snapshot.bytes);
    if (!record) return { state: "MALFORMED" };
    return { state: executorProcessIsAlive(record.pid) ? "LIVE" : "STALE", record, identity: snapshot.identity };
  } catch {
    const after = await fs.lstat(lockPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    return after ? { state: "MALFORMED" } : { state: "MISSING" };
  }
}
async function reclaimDeadExecutorLock(lockPath: string, observed: ExecutorLockObservation): Promise<void> {
  if (observed.state !== "STALE" || executorProcessIsAlive(observed.record.pid)) throw new ExecutorError("EXECUTOR_LOCKED", "Executor lock owner is not safely reclaimable.");
  const current = await fs.lstat(lockPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (!current) return;
  if (current.isSymbolicLink() || !current.isFile() || !sameStableFileIdentity(executorStableIdentity(current), observed.identity)) throw new ExecutorError("EXECUTOR_LOCKED", "Executor lock changed while stale recovery was being attested.");
  await fs.unlink(lockPath);
}
async function installExecutorLock(directory: string, lockPath: string, bytes: Buffer): Promise<StableFileIdentity | null> {
  const temporary = path.join(directory, `.executor-lock.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: fs.FileHandle | null = null;
  let linked = false;
  let installedIdentity: StableFileIdentity | null = null;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(bytes); await handle.sync();
    const prepared = await handle.stat();
    if (!prepared.isFile() || prepared.size !== bytes.byteLength) throw new ExecutorError("EXECUTOR_LOCKED", "Prepared executor lock is incomplete.");
    await handle.close(); handle = null;
    try { await fs.link(temporary, lockPath); linked = true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; }
    const installed = await fs.lstat(lockPath);
    if (installed.isSymbolicLink() || !installed.isFile() || !sameExecutorInode(prepared, installed)) throw new ExecutorError("EXECUTOR_LOCKED", "Executor lock changed while being atomically installed.");
    installedIdentity = executorStableIdentity(installed);
    return installedIdentity;
  } catch (error) {
    if (linked && installedIdentity) {
      const current = await fs.lstat(lockPath).catch(() => null);
      if (current && current.isFile() && !current.isSymbolicLink() && sameStableFileIdentity(executorStableIdentity(current), installedIdentity)) await fs.unlink(lockPath).catch(() => undefined);
    }
    throw error;
  } finally { await handle?.close().catch(() => undefined); await fs.unlink(temporary).catch(() => undefined); }
}

export async function acquireExecutorLock(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): Promise<ExecutorLock> {
  const paths = executorPaths(stateDirectory, taskId, taskBundleSha256, artifactSha256); await prepareExecutorDirectory(stateDirectory, paths.directory);
  let guard;
  try { guard = await acquireTicketFileLock(path.join(paths.directory, "executor-lock-acquire"), { timeoutMs: 5_000, pollMs: 25 }); }
  catch (error) {
    if (error instanceof TicketFileLockError) throw new ExecutorError("EXECUTOR_LOCKED", `Executor lock acquisition could not be serialized safely: ${error.message}`);
    throw error;
  }
  try {
    const observed = await inspectExecutorLock(paths.lock);
    if (observed.state === "LIVE") throw new ExecutorError("EXECUTOR_LOCKED", "Executor artifact is already locked by another live process.");
    if (observed.state === "MALFORMED") throw new ExecutorError("EXECUTOR_LOCKED", "Executor lock is malformed or unsafe; explicit operator recovery is required.");
    if (observed.state === "STALE") await reclaimDeadExecutorLock(paths.lock, observed);
    const nonce = crypto.randomBytes(24).toString("hex");
    const bytes = canonicalJsonBuffer({ pid: process.pid, nonce, created_at: new Date().toISOString() } satisfies ExecutorLockRecord);
    const installedIdentity = await installExecutorLock(paths.directory, paths.lock, bytes);
    if (!installedIdentity) throw new ExecutorError("EXECUTOR_LOCKED", "Executor artifact lock changed during serialized acquisition.");
    return { nonce, path: paths.lock, identity: installedIdentity };
  } finally { await guard.release().catch(() => undefined); }
}
export async function releaseExecutorLock(lock: ExecutorLock): Promise<void> {
  try {
    const snapshot = await readStableFile(lock.path, MAX_LOCK_BYTES);
    const current = parseExecutorLock(snapshot.bytes);
    if (!current || current.pid !== process.pid || current.nonce !== lock.nonce || !sameStableFileIdentity(snapshot.identity, lock.identity)) return;
    const beforeRemove = await fs.lstat(lock.path);
    if (beforeRemove.isSymbolicLink() || !beforeRemove.isFile() || !sameStableFileIdentity(executorStableIdentity(beforeRemove), lock.identity)) return;
    await fs.unlink(lock.path);
  } catch { return; }
}
