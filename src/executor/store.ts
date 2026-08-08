import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { ExecutorError, type ExecutorReceipt, type ExecutorState } from "./contracts.js";
import { executorPaths, prepareExecutorDirectory } from "./paths.js";
import { readStableExecutorStateFile } from "./state-io.js";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 8 * 1024;
const MAX_ERRORS = 32;
const MAX_DIAGNOSTIC_CHARS = 8192;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const STATES = new Set<ExecutorState>(["VALIDATING","PREPARED","APPLYING","APPLIED","VERIFYING","REVIEWING_TERRA","REVIEWING_SOL","READY_FOR_PUBLISH","ESCALATE_TO_WEB","FAILED"]);

function validDigest(value: string | null): boolean { return value === null || SHA256.test(value); }

function validateGateConsistency(receipt: ExecutorReceipt): void {
  const digest = receipt.change_set_digest;
  if (receipt.verification.passed && (receipt.verification.rounds < 1 || receipt.verification.change_set_digest === null || receipt.verification.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted verification approval lacks immutable evidence identity.");
  if (receipt.terra_review.verdict !== null && (receipt.terra_review.rounds < 1 || receipt.terra_review.change_set_digest === null || receipt.terra_review.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted Terra verdict lacks immutable evidence identity.");
  if (receipt.sol_review.verdict !== null && (receipt.sol_review.rounds < 1 || receipt.sol_review.change_set_digest === null || receipt.sol_review.evidence_sha256 === null)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Persisted Sol verdict lacks immutable evidence identity.");
  if (receipt.terra_review.verdict === "APPROVE" && (!receipt.verification.passed || digest === null || receipt.verification.change_set_digest !== digest || receipt.terra_review.change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Terra approval is not chained to an approved verification of the exact current digest.");
  if (receipt.sol_review.verdict === "APPROVE" && (receipt.terra_review.verdict !== "APPROVE" || digest === null || receipt.sol_review.change_set_digest !== digest || receipt.terra_review.change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Sol approval is not chained to Terra approval of the exact current digest.");
  if (receipt.state === "READY_FOR_PUBLISH" && (digest === null || !receipt.verification.passed || receipt.terra_review.verdict !== "APPROVE" || receipt.sol_review.verdict !== "APPROVE" || receipt.verification.change_set_digest !== digest || receipt.terra_review.change_set_digest !== digest || receipt.sol_review.change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY_FOR_PUBLISH lacks a complete exact-digest verification/Terra/Sol approval chain.");
}

function validateReceipt(receipt: ExecutorReceipt): void {
  if (receipt.executor_version !== "1.0" || !STATES.has(receipt.state) || receipt.run_id !== `${receipt.task_id}:${receipt.task_bundle_sha256}` || !SHA256.test(receipt.task_bundle_sha256) || !SHA256.test(receipt.artifact_sha256) || !SHA256.test(receipt.registration_manifest_sha256) || !GIT_SHA.test(receipt.base_commit) || !GIT_SHA.test(receipt.base_tree_sha) || !receipt.repository_id || !receipt.base_branch || !receipt.worktree_path) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt identity/state is invalid.");
  if (!Array.isArray(receipt.operations) || receipt.operations.length > 256 || !Array.isArray(receipt.errors) || receipt.errors.length > MAX_ERRORS) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt arrays exceed their bounds.");
  if (!validDigest(receipt.change_set_digest) || !validDigest(receipt.verification.change_set_digest) || !validDigest(receipt.verification.evidence_sha256) || !validDigest(receipt.terra_review.change_set_digest) || !validDigest(receipt.terra_review.evidence_sha256) || !validDigest(receipt.sol_review.change_set_digest) || !validDigest(receipt.sol_review.evidence_sha256)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt contains an invalid digest.");
  if (!Number.isSafeInteger(receipt.verification.rounds) || receipt.verification.rounds < 0 || receipt.verification.rounds > 32 || !Number.isSafeInteger(receipt.terra_review.rounds) || receipt.terra_review.rounds < 0 || receipt.terra_review.rounds > 32 || !Number.isSafeInteger(receipt.sol_review.rounds) || receipt.sol_review.rounds < 0 || receipt.sol_review.rounds > 32) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor gate round counters are invalid.");
  if (![null,"APPROVE","REVISE","ESCALATE"].includes(receipt.terra_review.verdict) || ![null,"APPROVE","REVISE","ESCALATE"].includes(receipt.sol_review.verdict)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor review verdict is invalid.");
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const operation of receipt.operations) {
    if (!operation.op_id || operation.op_id.length > 128 || ids.has(operation.op_id) || !operation.path || operation.path.length > 4096 || paths.has(operation.path) || !["create_file", "replace_file", "delete_file"].includes(operation.kind) || !validDigest(operation.preimage_sha256) || !validDigest(operation.postimage_sha256) || !validDigest(operation.backup_sha256) || typeof operation.applied !== "boolean" || operation.original_mode !== null && (!Number.isSafeInteger(operation.original_mode) || operation.original_mode < 0 || operation.original_mode > 0o777)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor operation identity/evidence is invalid or duplicated.");
    if (operation.backup_relative_path !== null && (operation.backup_relative_path.length > 4096 || operation.backup_relative_path.startsWith("/") || operation.backup_relative_path.includes(".."))) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor backup path is invalid.");
    ids.add(operation.op_id); paths.add(operation.path);
  }
  for (const error of receipt.errors) if (!error.code || error.code.length > 128 || error.message.length > MAX_DIAGNOSTIC_CHARS || !Number.isFinite(Date.parse(error.at))) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor diagnostic is invalid or oversized.");
  if (!Number.isFinite(Date.parse(receipt.created_at)) || !Number.isFinite(Date.parse(receipt.updated_at))) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt timestamps are invalid.");
  validateGateConsistency(receipt);
}

export async function readExecutorReceipt(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): Promise<ExecutorReceipt | null> {
  const paths = executorPaths(stateDirectory, taskId, taskBundleSha256, artifactSha256);
  let bytes: Buffer;
  try { bytes = await readStableExecutorStateFile(paths.receipt, MAX_RECEIPT_BYTES); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt must be an object.");
  const receipt = parsed as ExecutorReceipt;
  validateReceipt(receipt);
  return receipt;
}

export async function writeExecutorReceipt(stateDirectory: string, receipt: ExecutorReceipt): Promise<void> {
  validateReceipt(receipt);
  const paths = executorPaths(stateDirectory, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256);
  await prepareExecutorDirectory(stateDirectory, paths.directory);
  const bytes = canonicalJsonBuffer(receipt);
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt exceeds byte cap.");
  const temp = path.join(paths.directory, `.executor-receipt.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
  try {
    const existing = await fs.lstat(paths.receipt).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Executor receipt path is a symlink.");
    await fs.rename(temp, paths.receipt);
  } finally { await fs.unlink(temp).catch(() => undefined); }
}

export interface ExecutorLock { nonce: string; path: string; }

export async function acquireExecutorLock(stateDirectory: string, taskId: string, taskBundleSha256: string, artifactSha256: string): Promise<ExecutorLock> {
  const paths = executorPaths(stateDirectory, taskId, taskBundleSha256, artifactSha256);
  await prepareExecutorDirectory(stateDirectory, paths.directory);
  const nonce = crypto.randomBytes(24).toString("hex");
  try {
    await fs.writeFile(paths.lock, canonicalJsonBuffer({ pid: process.pid, nonce, created_at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ExecutorError("EXECUTOR_LOCKED", "Executor artifact is already locked; stale locks are never auto-stolen.");
    throw error;
  }
  return { nonce, path: paths.lock };
}

export async function releaseExecutorLock(lock: ExecutorLock): Promise<void> {
  let bytes: Buffer;
  try { bytes = await readStableExecutorStateFile(lock.path, MAX_LOCK_BYTES); }
  catch { return; }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { nonce?: unknown }).nonce !== lock.nonce) return;
  await fs.unlink(lock.path).catch(() => undefined);
}
