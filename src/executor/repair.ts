import crypto from "node:crypto";
import path from "node:path";
import type { ReviewerRepairOperation } from "../execution/contracts.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import type { WebImplementationPack, WebImplementationOperation } from "../web-authority/contracts.js";
import { ExecutorError, type ExecutorReceipt, type ExecutorRepairPreimageBackup, type ExecutorTransactionOperation } from "./contracts.js";
import { executorPaths, prepareExecutorDirectory } from "./paths.js";
import { ensureSecureExecutorSubdirectory, installImmutableDurableExecutorStateFile, readStableExecutorStateFile } from "./state-io.js";
import { writeExecutorReceipt } from "./store.js";
import { deleteExactWorktreeFile, readStableWorktreeFile, writeExactWorktreeFile } from "./worktree-io.js";

const MAX_REPAIR_GENERATIONS = 4;
const MAX_REPAIR_BACKUP_BYTES = 8 * 1024 * 1024;
function nowIso(now: () => Date): string { return now().toISOString(); }
function operationsDigest(operations: ReviewerRepairOperation[]): string { return crypto.createHash("sha256").update(canonicalJsonBuffer(operations)).digest("hex"); }
function payload(operation: ReviewerRepairOperation): Buffer | null {
  if (operation.kind === "delete_file") return null;
  if (operation.postimage_base64 === null || operation.postimage_sha256 === null) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair '${operation.op_id}' lacks postimage authority.`);
  const bytes = Buffer.from(operation.postimage_base64, "base64");
  if (bytes.toString("base64") !== operation.postimage_base64 || crypto.createHash("sha256").update(bytes).digest("hex") !== operation.postimage_sha256) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair '${operation.op_id}' postimage encoding/digest is invalid.`);
  return bytes;
}
function originalOperation(pack: WebImplementationPack, pathValue: string): WebImplementationOperation { const operation = pack.operations.operations.find((candidate) => candidate.path === pathValue); if (!operation) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair path '${pathValue}' is outside the registered Web implementation authority.`); return operation; }
function transaction(receipt: ExecutorReceipt, pathValue: string): ExecutorTransactionOperation { const operation = receipt.operations.find((candidate) => candidate.path === pathValue); if (!operation) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair path '${pathValue}' is outside the executor transaction.`); return operation; }
function originalPayload(pack: WebImplementationPack, operation: WebImplementationOperation): Buffer | null { if (operation.kind === "delete_file") return null; if (!operation.payload_entry) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Original Web operation '${operation.op_id}' lacks payload authority.`); const bytes = pack.entries.get(operation.payload_entry); if (!bytes) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Original Web payload '${operation.payload_entry}' is unavailable.`); return bytes; }

async function classifyRepair(receipt: ExecutorReceipt, operation: ReviewerRepairOperation): Promise<"preimage" | "postimage" | "ambiguous"> {
  const current = await readStableWorktreeFile(receipt.worktree_path, operation.path);
  if (operation.kind === "create_file") { if (!current) return "preimage"; return current.sha256 === operation.postimage_sha256 ? "postimage" : "ambiguous"; }
  if (operation.kind === "delete_file") { if (!current) return "postimage"; return current.sha256 === operation.preimage_sha256 ? "preimage" : "ambiguous"; }
  if (!current) return "ambiguous";
  if (current.sha256 === operation.preimage_sha256) return "preimage";
  if (current.sha256 === operation.postimage_sha256) return "postimage";
  return "ambiguous";
}
async function assertProposalPreimages(receipt: ExecutorReceipt, operations: ReviewerRepairOperation[]): Promise<void> {
  const allowed = new Set(receipt.operations.map((operation) => operation.path));
  for (const operation of operations) { if (!allowed.has(operation.path)) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair widens path authority at '${operation.path}'.`); if (await classifyRepair(receipt, operation) !== "preimage") throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair preimage is stale or ambiguous at '${operation.path}'.`); }
}

async function captureGenerationPreimages(options: { stateDirectory: string; receipt: ExecutorReceipt; evidenceSha256: string; operations: ReviewerRepairOperation[] }): Promise<ExecutorRepairPreimageBackup[]> {
  const paths = executorPaths(options.stateDirectory, options.receipt.task_id, options.receipt.task_bundle_sha256, options.receipt.artifact_sha256);
  await prepareExecutorDirectory(options.stateDirectory, paths.directory);
  const directory = path.join(paths.backups, "repairs");
  await ensureSecureExecutorSubdirectory(paths.directory, directory);
  const backups: ExecutorRepairPreimageBackup[] = [];
  for (const operation of options.operations) {
    if (operation.kind === "create_file") continue;
    const current = await readStableWorktreeFile(options.receipt.worktree_path, operation.path);
    if (!current || current.sha256 !== operation.preimage_sha256) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair preimage changed before backup at '${operation.path}'.`);
    const originalPostimage = transaction(options.receipt, operation.path).postimage_sha256;
    if (originalPostimage !== null && current.sha256 === originalPostimage) continue;
    if (current.bytes.byteLength > MAX_REPAIR_BACKUP_BYTES) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair generation backup exceeds ${MAX_REPAIR_BACKUP_BYTES} bytes at '${operation.path}'.`);
    const filename = `${options.evidenceSha256}-${operation.op_id}-${current.sha256}.bin`;
    const finalPath = path.join(directory, filename);
    await installImmutableDurableExecutorStateFile(finalPath, current.bytes, MAX_REPAIR_BACKUP_BYTES);
    backups.push({ path: operation.path, sha256: current.sha256, relative_path: path.relative(paths.directory, finalPath).split(path.sep).join("/"), mode: current.mode });
  }
  return backups;
}

export async function bindReviewerRepair(options: { stateDirectory: string; receipt: ExecutorReceipt; reviewer: "terra" | "sol"; sourceChangeSetDigest: string; sourceReviewEvidenceSha256: string; operations: ReviewerRepairOperation[]; now?: () => Date; }): Promise<ExecutorReceipt> {
  const now = options.now ?? (() => new Date()); const receipt = options.receipt;
  if (receipt.review_strategy !== "model" || receipt.reviewer_selection?.kind !== options.reviewer || receipt.repair) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "Adaptive repair cannot be bound to this executor authority.");
  const review = options.reviewer === "terra" ? receipt.terra_review : receipt.sol_review;
  if (review.verdict !== "REVISE" || review.change_set_digest !== options.sourceChangeSetDigest || review.evidence_sha256 !== options.sourceReviewEvidenceSha256) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "Adaptive repair does not bind the selected REVISE evidence.");
  await assertProposalPreimages(receipt, options.operations);
  receipt.repair = { reviewer: options.reviewer, source_change_set_digest: options.sourceChangeSetDigest, source_review_evidence_sha256: options.sourceReviewEvidenceSha256, operations: options.operations, state: "PROPOSED", final_change_set_digest: null };
  receipt.updated_at = nowIso(now); await writeExecutorReceipt(options.stateDirectory, receipt); return receipt;
}

function archiveVerifiedWebRepair(receipt: ExecutorReceipt, now: () => Date): void {
  const repair = receipt.repair;
  if (!repair || repair.reviewer !== "web" || repair.state !== "VERIFIED" || !repair.final_change_set_digest || repair.final_change_set_digest !== receipt.change_set_digest || !receipt.verification.passed || receipt.verification.change_set_digest !== repair.final_change_set_digest) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "Only the exact deterministically verified Web repair generation may be archived.");
  const history = receipt.repair_history ?? [];
  if (history.length >= MAX_REPAIR_GENERATIONS) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Web repair generation budget ${MAX_REPAIR_GENERATIONS} is exhausted.`);
  const previous = history.at(-1);
  if (previous && previous.final_change_set_digest !== repair.source_change_set_digest) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "Web repair history digest chain is broken.");
  history.push({ generation: history.length + 1, reviewer: "web", source_change_set_digest: repair.source_change_set_digest, source_review_evidence_sha256: repair.source_review_evidence_sha256, operations_sha256: operationsDigest(repair.operations), operation_count: repair.operations.length, final_change_set_digest: repair.final_change_set_digest, verified_at: nowIso(now) });
  receipt.repair_history = history; delete receipt.repair;
}

export async function bindWebReviewRepair(options: { stateDirectory: string; receipt: ExecutorReceipt; sourceChangeSetDigest: string; sourceReviewEvidenceSha256: string; operations: ReviewerRepairOperation[]; now?: () => Date; }): Promise<ExecutorReceipt> {
  const now = options.now ?? (() => new Date()); const receipt = options.receipt;
  if (receipt.repair) {
    const same = receipt.repair.reviewer === "web" && receipt.repair.source_change_set_digest === options.sourceChangeSetDigest && receipt.repair.source_review_evidence_sha256 === options.sourceReviewEvidenceSha256 && operationsDigest(receipt.repair.operations) === operationsDigest(options.operations);
    if (same) return receipt;
    archiveVerifiedWebRepair(receipt, now);
  }
  const previous = receipt.repair_history?.at(-1);
  if (receipt.review_strategy !== "web" || receipt.reviewer_selection !== undefined || receipt.state !== "READY_FOR_PUBLISH" || receipt.change_set_digest !== options.sourceChangeSetDigest || !receipt.verification.passed || receipt.verification.change_set_digest !== options.sourceChangeSetDigest || (previous && previous.final_change_set_digest !== options.sourceChangeSetDigest) || receipt.terra_review.rounds !== 0 || receipt.sol_review.rounds !== 0 || receipt.terra_review.verdict !== null || receipt.sol_review.verdict !== null) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "Web repair cannot be bound to this PAIR Harness authority.");
  if (!/^[a-f0-9]{64}$/.test(options.sourceReviewEvidenceSha256)) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "Web repair evidence digest is invalid.");
  await assertProposalPreimages(receipt, options.operations);
  const preimageBackups = await captureGenerationPreimages({ stateDirectory: options.stateDirectory, receipt, evidenceSha256: options.sourceReviewEvidenceSha256, operations: options.operations });
  receipt.repair = { reviewer: "web", source_change_set_digest: options.sourceChangeSetDigest, source_review_evidence_sha256: options.sourceReviewEvidenceSha256, operations: options.operations, ...(preimageBackups.length ? { preimage_backups: preimageBackups } : {}), state: "PROPOSED", final_change_set_digest: null };
  receipt.state = "REVIEWING_WEB"; receipt.updated_at = nowIso(now); await writeExecutorReceipt(options.stateDirectory, receipt); return receipt;
}

async function restoreOriginalPostimage(receipt: ExecutorReceipt, pack: WebImplementationPack, repair: ReviewerRepairOperation): Promise<void> {
  const source = originalOperation(pack, repair.path); const tx = transaction(receipt, repair.path); const bytes = originalPayload(pack, source); const current = await readStableWorktreeFile(receipt.worktree_path, repair.path);
  if (source.kind === "delete_file") { if (current) await deleteExactWorktreeFile(receipt.worktree_path, repair.path); return; }
  if (!bytes || !tx.postimage_sha256) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Original postimage authority is incomplete for '${repair.path}'.`);
  if (current?.sha256 === tx.postimage_sha256) return;
  const mode = source.kind === "create_file" ? 0o644 : tx.original_mode ?? 0o644;
  if (!current) await writeExactWorktreeFile(receipt.worktree_path, repair.path, bytes, mode, true); else await writeExactWorktreeFile(receipt.worktree_path, repair.path, bytes, mode, false);
}
async function readGenerationBackup(stateDirectory: string, receipt: ExecutorReceipt, operation: ReviewerRepairOperation): Promise<{ bytes: Buffer; mode: number } | null> {
  const backup = receipt.repair?.preimage_backups?.find((candidate) => candidate.path === operation.path);
  if (!backup) return null;
  const base = executorPaths(stateDirectory, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256).directory;
  const expectedPrefix = "backups/repairs/";
  if (!backup.relative_path.startsWith(expectedPrefix) || backup.relative_path.includes("..")) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair backup path is not canonical for '${operation.path}'.`);
  const bytes = await readStableExecutorStateFile(path.join(base, ...backup.relative_path.split("/")), MAX_REPAIR_BACKUP_BYTES);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== backup.sha256 || backup.sha256 !== operation.preimage_sha256) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", `Repair generation backup digest mismatch for '${operation.path}'.`);
  return { bytes, mode: backup.mode };
}
async function rollbackRepairs(stateDirectory: string, receipt: ExecutorReceipt, pack: WebImplementationPack): Promise<void> {
  if (!receipt.repair) return;
  for (const operation of [...receipt.repair.operations].reverse()) {
    const classification = await classifyRepair(receipt, operation);
    if (classification === "ambiguous") throw new ExecutorError("EXECUTOR_AMBIGUOUS_RECOVERY", `Repair rollback found an ambiguous target at '${operation.path}'.`);
    if (classification !== "postimage") continue;
    if (operation.kind === "create_file") { await deleteExactWorktreeFile(receipt.worktree_path, operation.path); continue; }
    const backup = await readGenerationBackup(stateDirectory, receipt, operation);
    if (backup) {
      const current = await readStableWorktreeFile(receipt.worktree_path, operation.path);
      await writeExactWorktreeFile(receipt.worktree_path, operation.path, backup.bytes, backup.mode, !current);
    } else await restoreOriginalPostimage(receipt, pack, operation);
    if (await classifyRepair(receipt, operation) !== "preimage") throw new ExecutorError("EXECUTOR_AMBIGUOUS_RECOVERY", `Repair rollback failed to restore exact generation preimage at '${operation.path}'.`);
  }
}

export async function applyReviewerRepair(options: { stateDirectory: string; receipt: ExecutorReceipt; pack: WebImplementationPack; now?: () => Date }): Promise<ExecutorReceipt> {
  const now = options.now ?? (() => new Date()); const receipt = options.receipt; const repair = receipt.repair;
  if (!repair || !["PROPOSED", "APPLYING", "APPLIED"].includes(repair.state)) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "No resumable adaptive repair is bound to this executor.");
  if (repair.state === "APPLIED") return receipt;
  repair.state = "APPLYING"; receipt.state = "REPAIR_APPLYING"; receipt.updated_at = nowIso(now); await writeExecutorReceipt(options.stateDirectory, receipt);
  try {
    for (const operation of repair.operations) {
      const classification = await classifyRepair(receipt, operation);
      if (classification === "ambiguous") throw new ExecutorError("EXECUTOR_AMBIGUOUS_RECOVERY", `Repair target '${operation.path}' is neither exact preimage nor postimage.`);
      if (classification === "postimage") continue;
      const current = await readStableWorktreeFile(receipt.worktree_path, operation.path);
      if (operation.kind === "create_file") { const tx = transaction(receipt, operation.path); await writeExactWorktreeFile(receipt.worktree_path, operation.path, payload(operation)!, tx.original_mode ?? 0o644, true); }
      else if (operation.kind === "replace_file") { if (!current || current.sha256 !== operation.preimage_sha256) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Repair replace preimage changed at '${operation.path}'.`); await writeExactWorktreeFile(receipt.worktree_path, operation.path, payload(operation)!, current.mode, false); }
      else { if (!current || current.sha256 !== operation.preimage_sha256) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Repair delete preimage changed at '${operation.path}'.`); await deleteExactWorktreeFile(receipt.worktree_path, operation.path); }
      if (await classifyRepair(receipt, operation) !== "postimage") throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Repair postimage mismatch at '${operation.path}'.`);
    }
  } catch (error) {
    try { await rollbackRepairs(options.stateDirectory, receipt, options.pack); } catch (rollbackError) { throw new ExecutorError("EXECUTOR_AMBIGUOUS_RECOVERY", `Adaptive repair failed and rollback could not restore the exact source generation: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`); }
    repair.state = "PROPOSED"; receipt.state = repair.reviewer === "web" ? "REVIEWING_WEB" : repair.reviewer === "terra" ? "REVIEWING_TERRA" : "REVIEWING_SOL"; receipt.updated_at = nowIso(now); await writeExecutorReceipt(options.stateDirectory, receipt); throw error;
  }
  repair.state = "APPLIED"; receipt.state = "REPAIR_APPLIED"; receipt.verification = { ...receipt.verification, passed: false, change_set_digest: null, evidence_sha256: null }; receipt.updated_at = nowIso(now); await writeExecutorReceipt(options.stateDirectory, receipt); return receipt;
}