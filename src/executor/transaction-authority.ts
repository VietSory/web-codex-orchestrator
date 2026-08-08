import crypto from "node:crypto";
import path from "node:path";
import type { WebImplementationPack, WebImplementationOperation } from "../web-authority/contracts.js";
import { ExecutorError, type ExecutorReceipt, type ExecutorTransactionOperation } from "./contracts.js";
import { executorPaths } from "./paths.js";
import { readStableExecutorStateFile } from "./state-io.js";

const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

function sha256(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function expectedPostimage(pack: WebImplementationPack, operation: WebImplementationOperation): string | null {
  if (operation.kind === "delete_file") return null;
  if (!operation.payload_entry) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Registered operation '${operation.op_id}' has no payload entry.`);
  const payload = pack.entries.get(operation.payload_entry);
  if (!payload || sha256(payload) !== operation.payload_sha256) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Registered payload binding drifted for '${operation.path}'.`);
  return sha256(payload);
}

function expectedBackupRelativePath(operation: WebImplementationOperation): string | null {
  return operation.kind === "create_file" || operation.preimage_sha256 === null ? null : `backups/${operation.op_id}-${operation.preimage_sha256}.bin`;
}

function assertOne(transaction: ExecutorTransactionOperation, operation: WebImplementationOperation, pack: WebImplementationPack): void {
  if (transaction.op_id !== operation.op_id || transaction.kind !== operation.kind || transaction.path !== operation.path || transaction.preimage_sha256 !== operation.preimage_sha256 || transaction.postimage_sha256 !== expectedPostimage(pack, operation)) {
    throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Persisted transaction no longer matches registered operation '${operation.op_id}'.`);
  }
  if (operation.kind === "create_file") {
    if (transaction.backup_relative_path !== null || transaction.backup_sha256 !== null || transaction.original_mode !== null) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Create transaction carries impossible backup authority for '${operation.path}'.`);
    return;
  }
  if (transaction.backup_relative_path !== expectedBackupRelativePath(operation) || transaction.backup_sha256 !== operation.preimage_sha256 || transaction.original_mode === null) {
    throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Replace/delete transaction lost exact backup authority for '${operation.path}'.`);
  }
}

export function assertExecutorTransactionBoundToPack(receipt: ExecutorReceipt, pack: WebImplementationPack): void {
  if (receipt.operations.length !== pack.operations.operations.length) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", "Persisted transaction operation count differs from registered Web pack.");
  const byId = new Map(receipt.operations.map((operation) => [operation.op_id, operation]));
  for (const operation of pack.operations.operations) {
    const transaction = byId.get(operation.op_id);
    if (!transaction) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Persisted transaction is missing registered operation '${operation.op_id}'.`);
    assertOne(transaction, operation, pack);
  }
}

export async function attestExecutorTransactionBackups(stateDirectory: string, receipt: ExecutorReceipt): Promise<void> {
  const base = executorPaths(stateDirectory, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256).directory;
  for (const operation of receipt.operations) {
    if (operation.kind === "create_file") continue;
    if (!operation.backup_relative_path || !operation.backup_sha256) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Persisted transaction has no backup authority for '${operation.path}'.`);
    const expected = `backups/${operation.op_id}-${operation.backup_sha256}.bin`;
    if (operation.backup_relative_path !== expected) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Persisted backup path is not canonical for '${operation.path}'.`);
    const backupPath = path.join(base, ...expected.split("/"));
    let bytes: Buffer;
    try { bytes = await readStableExecutorStateFile(backupPath, MAX_BACKUP_BYTES); }
    catch (error) { throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Persisted preimage backup is unavailable for '${operation.path}': ${error instanceof Error ? error.message : String(error)}`); }
    if (sha256(bytes) !== operation.backup_sha256) throw new ExecutorError("EXECUTOR_TRANSACTION_INVALID", `Persisted preimage backup hash changed for '${operation.path}'.`);
  }
}
