import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import type { WebImplementationPack, WebImplementationOperation } from "../web-authority/contracts.js";
import { ExecutorError, type ExecutorReceipt, type ExecutorTransactionOperation } from "./contracts.js";
import { executorPaths, prepareExecutorDirectory } from "./paths.js";
import { readExecutorReceipt, writeExecutorReceipt } from "./store.js";
import { deleteExactWorktreeFile, readStableWorktreeFile, writeExactWorktreeFile } from "./worktree-io.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

function sha256(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function nowIso(now: () => Date): string { return now().toISOString(); }

function payloadFor(pack: WebImplementationPack, operation: WebImplementationOperation): Buffer | null {
  if (operation.kind === "delete_file") return null;
  const entry = operation.payload_entry;
  if (!entry) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Operation '${operation.op_id}' has no payload entry.`);
  const payload = pack.entries.get(entry);
  if (!payload || sha256(payload) !== operation.payload_sha256) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Operation '${operation.op_id}' payload no longer matches the registered pack.`);
  return payload;
}

async function installBackup(options: { stateDirectory: string; receipt: ExecutorReceipt; operation: WebImplementationOperation; bytes: Buffer }): Promise<string> {
  if (options.bytes.byteLength > MAX_BACKUP_BYTES) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Backup exceeds executor cap for '${options.operation.path}'.`);
  const paths = executorPaths(options.stateDirectory, options.receipt.task_id, options.receipt.task_bundle_sha256, options.receipt.artifact_sha256);
  await prepareExecutorDirectory(options.stateDirectory, paths.directory);
  await fs.mkdir(paths.backups, { recursive: true, mode: 0o700 });
  const digest = sha256(options.bytes);
  const filename = `${options.operation.op_id}-${digest}.bin`;
  const finalPath = path.join(paths.backups, filename);
  try { await fs.writeFile(finalPath, options.bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(finalPath);
    if (existing.byteLength !== options.bytes.byteLength || sha256(existing) !== digest) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Existing backup bytes differ for '${options.operation.path}'.`);
  }
  return path.relative(paths.directory, finalPath).split(path.sep).join("/");
}

function baseReceipt(options: { runId: string; taskId: string; taskBundleSha256: string; artifactSha256: string; pack: WebImplementationPack; repositoryId: string; baseBranch: string; baseCommit: string; baseTreeSha: string; worktreePath: string; registrationManifestSha256: string; now: () => Date }): ExecutorReceipt {
  const timestamp = nowIso(options.now);
  return {
    executor_version: "1.0",
    run_id: options.runId,
    task_id: options.taskId,
    task_bundle_sha256: options.taskBundleSha256,
    artifact_sha256: options.artifactSha256,
    pack_id: options.pack.manifest.pack_id,
    state: "VALIDATING",
    repository_id: options.repositoryId,
    base_branch: options.baseBranch,
    base_commit: options.baseCommit,
    base_tree_sha: options.baseTreeSha,
    worktree_path: options.worktreePath,
    registration_manifest_sha256: options.registrationManifestSha256,
    operations: [],
    change_set_digest: null,
    verification: { rounds: 0, passed: false, change_set_digest: null, evidence_sha256: null },
    terra_review: { rounds: 0, verdict: null, change_set_digest: null, evidence_sha256: null },
    sol_review: { rounds: 0, verdict: null, change_set_digest: null, evidence_sha256: null },
    errors: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function prepareExecutorTransaction(options: {
  stateDirectory: string;
  runId: string;
  taskId: string;
  taskBundleSha256: string;
  artifactSha256: string;
  pack: WebImplementationPack;
  repositoryId: string;
  baseBranch: string;
  baseCommit: string;
  baseTreeSha: string;
  worktreePath: string;
  registrationManifestSha256: string;
  now?: () => Date;
}): Promise<ExecutorReceipt> {
  const now = options.now ?? (() => new Date());
  const existing = await readExecutorReceipt(options.stateDirectory, options.taskId, options.taskBundleSha256, options.artifactSha256);
  if (existing) return existing;
  const receipt = baseReceipt({ ...options, now });
  const prepared: ExecutorTransactionOperation[] = [];

  // Critical invariant: inspect every preimage before the first product write.
  for (const operation of options.pack.operations.operations) {
    const current = await readStableWorktreeFile(options.worktreePath, operation.path);
    const payload = payloadFor(options.pack, operation);
    if (operation.kind === "create_file") {
      if (current !== null || operation.preimage_sha256 !== null || !payload) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Create precondition failed for '${operation.path}'.`);
      prepared.push({ op_id: operation.op_id, kind: operation.kind, path: operation.path, preimage_sha256: null, postimage_sha256: sha256(payload), backup_relative_path: null, backup_sha256: null, original_mode: null, applied: false });
      continue;
    }
    if (!current || !operation.preimage_sha256 || current.sha256 !== operation.preimage_sha256) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Exact preimage is stale for '${operation.path}'.`);
    const backupRelative = await installBackup({ stateDirectory: options.stateDirectory, receipt, operation, bytes: current.bytes });
    prepared.push({
      op_id: operation.op_id,
      kind: operation.kind,
      path: operation.path,
      preimage_sha256: operation.preimage_sha256,
      postimage_sha256: payload ? sha256(payload) : null,
      backup_relative_path: backupRelative,
      backup_sha256: current.sha256,
      original_mode: current.mode,
      applied: false,
    });
  }
  receipt.operations = prepared;
  receipt.state = "PREPARED";
  receipt.updated_at = nowIso(now);
  await writeExecutorReceipt(options.stateDirectory, receipt);
  return receipt;
}

async function classifyTarget(worktree: string, operation: ExecutorTransactionOperation): Promise<"preimage" | "postimage" | "ambiguous"> {
  const current = await readStableWorktreeFile(worktree, operation.path);
  if (operation.kind === "create_file") {
    if (!current) return "preimage";
    return current.sha256 === operation.postimage_sha256 ? "postimage" : "ambiguous";
  }
  if (operation.kind === "delete_file") {
    if (!current) return "postimage";
    return current.sha256 === operation.preimage_sha256 ? "preimage" : "ambiguous";
  }
  if (!current) return "ambiguous";
  if (current.sha256 === operation.preimage_sha256) return "preimage";
  if (current.sha256 === operation.postimage_sha256) return "postimage";
  return "ambiguous";
}

function matchingPackOperation(pack: WebImplementationPack, transaction: ExecutorTransactionOperation): WebImplementationOperation {
  const operation = pack.operations.operations.find((candidate) => candidate.op_id === transaction.op_id && candidate.path === transaction.path && candidate.kind === transaction.kind);
  if (!operation) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Transaction operation '${transaction.op_id}' no longer exists in registered pack.`);
  return operation;
}

export async function applyExecutorTransaction(options: { stateDirectory: string; receipt: ExecutorReceipt; pack: WebImplementationPack; now?: () => Date }): Promise<ExecutorReceipt> {
  const now = options.now ?? (() => new Date());
  const receipt = options.receipt;
  if (!["PREPARED", "APPLYING", "APPLIED"].includes(receipt.state)) throw new ExecutorError("EXECUTOR_STATE_INVALID", `Cannot apply executor transaction from state '${receipt.state}'.`);
  if (receipt.state === "APPLIED") return receipt;
  receipt.state = "APPLYING";
  receipt.updated_at = nowIso(now);
  await writeExecutorReceipt(options.stateDirectory, receipt);

  for (const transaction of receipt.operations) {
    const sourceOperation = matchingPackOperation(options.pack, transaction);
    const classification = await classifyTarget(receipt.worktree_path, transaction);
    if (classification === "ambiguous") throw new ExecutorError("EXECUTOR_AMBIGUOUS_RECOVERY", `Target '${transaction.path}' is neither registered preimage nor postimage.`);
    if (classification === "preimage") {
      const current = await readStableWorktreeFile(receipt.worktree_path, transaction.path);
      if (transaction.kind === "create_file") {
        const payload = payloadFor(options.pack, sourceOperation)!;
        await writeExactWorktreeFile(receipt.worktree_path, transaction.path, payload, 0o644, true);
      } else if (transaction.kind === "replace_file") {
        if (!current || current.sha256 !== transaction.preimage_sha256) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Replace preimage changed immediately before write: '${transaction.path}'.`);
        const payload = payloadFor(options.pack, sourceOperation)!;
        await writeExactWorktreeFile(receipt.worktree_path, transaction.path, payload, transaction.original_mode ?? 0o644, false);
      } else {
        if (!current || current.sha256 !== transaction.preimage_sha256) throw new ExecutorError("EXECUTOR_PREIMAGE_STALE", `Delete preimage changed immediately before write: '${transaction.path}'.`);
        await deleteExactWorktreeFile(receipt.worktree_path, transaction.path);
      }
    }
    const post = await classifyTarget(receipt.worktree_path, transaction);
    if (post !== "postimage") throw new ExecutorError("EXECUTOR_POSTIMAGE_MISMATCH", `Exact postimage was not produced for '${transaction.path}'.`);
    transaction.applied = true;
    receipt.updated_at = nowIso(now);
    await writeExecutorReceipt(options.stateDirectory, receipt);
  }
  receipt.state = "APPLIED";
  receipt.updated_at = nowIso(now);
  await writeExecutorReceipt(options.stateDirectory, receipt);
  return receipt;
}

export function computeExecutorChangeSetDigest(receipt: ExecutorReceipt): string {
  if (!receipt.operations.every((operation) => operation.applied)) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", "Cannot compute executor digest before every operation is applied.");
  const body = {
    version: "1.0",
    run_id: receipt.run_id,
    artifact_sha256: receipt.artifact_sha256,
    base_commit: receipt.base_commit,
    operations: receipt.operations.map((operation) => ({ op_id: operation.op_id, kind: operation.kind, path: operation.path, preimage_sha256: operation.preimage_sha256, postimage_sha256: operation.postimage_sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  return crypto.createHash("sha256").update(canonicalJsonBuffer(body)).digest("hex");
}

export function assertExecutorDigest(value: string): void {
  if (!SHA256.test(value)) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", "Executor change-set digest is invalid.");
}
