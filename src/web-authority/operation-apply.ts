import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { WebAuthorityError, type WebImplementationPack } from "./contracts.js";
import {
  assertNoSymlinkAncestors,
  payloadForOperation,
  readObservedPreimage,
  type WebOperationPreflightPlan,
} from "./operation-preflight.js";

interface BackupRecord {
  operation_index: number;
  relative_path: string;
  original_sha256: string | null;
  backup_relative_path: string | null;
  backup_sha256: string | null;
}

export interface WebOperationTransactionJournal {
  schema_version: "1.0";
  run_id: string;
  artifact_sha256: string;
  plan_sha256: string;
  worktree_root: string;
  status: "applying" | "committed" | "rolling_back" | "rolled_back";
  backups: BackupRecord[];
  completed_operation_indexes: number[];
  updated_at: string;
}

export interface WebOperationApplyResult {
  journal_path: string;
  status: "committed";
  plan_sha256: string;
  applied_operations: number;
}

function safeToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function ensureRealDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WebAuthorityError("WEB_AUTHORITY_STATE_DIR_UNSAFE", "Operation transaction state must be a real directory.");
  }
  return resolved;
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath: string, bytes: Buffer, mode = 0o600): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function atomicCopy(sourcePath: string, targetPath: string): Promise<void> {
  const directory = path.dirname(targetPath);
  const temporary = path.join(directory, `.${path.basename(targetPath)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.copyFile(sourcePath, temporary);
    await syncFile(temporary);
    await fs.rename(temporary, targetPath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function writeJournal(journalPath: string, journal: WebOperationTransactionJournal): Promise<void> {
  await atomicWrite(journalPath, canonicalJsonBuffer(journal));
}

async function assertExistingRealParent(root: string, relativePath: string): Promise<void> {
  await assertNoSymlinkAncestors(root, relativePath);
  const parent = path.dirname(path.join(root, ...relativePath.split("/")));
  const stat = await fs.lstat(parent).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", `Operation parent must already exist as a real directory: ${relativePath}`);
  }
}

function assertPlanMatchesPack(plan: WebOperationPreflightPlan, pack: WebImplementationPack): void {
  if (
    plan.run_id !== pack.manifest.run_id ||
    plan.artifact_sha256 !== pack.archive_sha256 ||
    plan.operations.length !== pack.operations.operations.length
  ) {
    throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", "Preflight plan no longer matches the registered Web pack.");
  }
  for (let index = 0; index < plan.operations.length; index += 1) {
    const prepared = plan.operations[index]!;
    const operation = pack.operations.operations[index]!;
    if (
      prepared.op_id !== operation.op_id ||
      prepared.kind !== operation.kind ||
      prepared.relative_path !== operation.path ||
      prepared.observed_preimage_sha256 !== operation.preimage_sha256 ||
      prepared.payload_sha256 !== (operation.payload_sha256 ?? null)
    ) {
      throw new WebAuthorityError("WEB_AUTHORITY_BINDING_MISMATCH", `Preflight operation ${index} no longer matches the Web pack.`);
    }
  }
}

async function readJournal(journalPath: string): Promise<WebOperationTransactionJournal> {
  const bytes = await fs.readFile(journalPath);
  const parsed = JSON.parse(bytes.toString("utf8")) as WebOperationTransactionJournal;
  if (parsed.schema_version !== "1.0" || !Array.isArray(parsed.backups) || !Array.isArray(parsed.completed_operation_indexes)) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATIONAL_ERROR", "Operation transaction journal is invalid.");
  }
  return parsed;
}

export async function recoverWebOperationTransaction(options: {
  journalPath: string;
}): Promise<WebOperationTransactionJournal> {
  const journalPath = path.resolve(options.journalPath);
  const journal = await readJournal(journalPath);
  if (journal.status === "committed" || journal.status === "rolled_back") return journal;

  const root = path.resolve(journal.worktree_root);
  const transactionDirectory = path.dirname(journalPath);
  journal.status = "rolling_back";
  journal.updated_at = new Date().toISOString();
  await writeJournal(journalPath, journal);

  for (const backup of [...journal.backups].reverse()) {
    const target = path.join(root, ...backup.relative_path.split("/"));
    await assertExistingRealParent(root, backup.relative_path);
    if (backup.original_sha256 === null) {
      await fs.rm(target, { force: true });
      continue;
    }
    if (!backup.backup_relative_path || !backup.backup_sha256) {
      throw new WebAuthorityError("WEB_AUTHORITY_OPERATIONAL_ERROR", "Rollback backup metadata is incomplete.");
    }
    const backupObserved = await readObservedPreimage(transactionDirectory, backup.backup_relative_path);
    if (backupObserved.sha256 !== backup.backup_sha256 || backup.backup_sha256 !== backup.original_sha256) {
      throw new WebAuthorityError("WEB_AUTHORITY_OPERATIONAL_ERROR", `Rollback backup checksum mismatch: ${backup.relative_path}`);
    }
    const backupPath = path.join(transactionDirectory, ...backup.backup_relative_path.split("/"));
    await atomicCopy(backupPath, target);
    const restored = await readObservedPreimage(root, backup.relative_path);
    if (restored.sha256 !== backup.original_sha256) {
      throw new WebAuthorityError("WEB_AUTHORITY_OPERATIONAL_ERROR", `Rollback verification failed: ${backup.relative_path}`);
    }
  }

  journal.status = "rolled_back";
  journal.updated_at = new Date().toISOString();
  await writeJournal(journalPath, journal);
  return journal;
}

export async function applyWebOperations(options: {
  stateDirectory: string;
  plan: WebOperationPreflightPlan;
  pack: WebImplementationPack;
}): Promise<WebOperationApplyResult> {
  assertPlanMatchesPack(options.plan, options.pack);
  const root = path.resolve(options.plan.worktree_root);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WebAuthorityError("WEB_AUTHORITY_OPERATION_INVALID", "Operation worktree root is no longer a real directory.");
  }

  // Validate every parent before the first mutation so unsupported directory creation fails as a whole-plan error.
  for (const prepared of options.plan.operations) {
    await assertExistingRealParent(root, prepared.relative_path);
  }

  const stateRoot = await ensureRealDirectory(options.stateDirectory);
  const transactionsRoot = path.join(stateRoot, "operation-transactions");
  await fs.mkdir(transactionsRoot, { recursive: true, mode: 0o700 });
  const transactionDirectory = path.join(transactionsRoot, safeToken(options.plan.plan_sha256));
  await fs.mkdir(transactionDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      throw new WebAuthorityError("WEB_AUTHORITY_OPERATIONAL_ERROR", "A transaction already exists for this exact preflight plan; recover or inspect it instead of replaying blindly.");
    }
    throw error;
  });
  const backupDirectory = path.join(transactionDirectory, "backups");
  await fs.mkdir(backupDirectory, { mode: 0o700 });
  const journalPath = path.join(transactionDirectory, "journal.json");
  const journal: WebOperationTransactionJournal = {
    schema_version: "1.0",
    run_id: options.plan.run_id,
    artifact_sha256: options.plan.artifact_sha256,
    plan_sha256: options.plan.plan_sha256,
    worktree_root: root,
    status: "applying",
    backups: [],
    completed_operation_indexes: [],
    updated_at: new Date().toISOString(),
  };
  await writeJournal(journalPath, journal);

  try {
    for (let index = 0; index < options.plan.operations.length; index += 1) {
      const prepared = options.plan.operations[index]!;
      const operation = options.pack.operations.operations[index]!;
      const target = path.join(root, ...prepared.relative_path.split("/"));
      await assertExistingRealParent(root, prepared.relative_path);
      const observed = await readObservedPreimage(root, prepared.relative_path);
      if (observed.sha256 !== prepared.observed_preimage_sha256 || observed.sizeBytes !== prepared.observed_preimage_size_bytes) {
        throw new WebAuthorityError("WEB_AUTHORITY_PREIMAGE_INVALID", `Preimage changed after preflight: ${prepared.relative_path}`);
      }

      let backupRelativePath: string | null = null;
      let backupSha256: string | null = null;
      if (observed.sha256 !== null) {
        backupRelativePath = path.posix.join("backups", `${String(index).padStart(4, "0")}.bin`);
        const backupPath = path.join(transactionDirectory, ...backupRelativePath.split("/"));
        await fs.copyFile(target, backupPath);
        await syncFile(backupPath);
        const backupObserved = await readObservedPreimage(transactionDirectory, backupRelativePath);
        backupSha256 = backupObserved.sha256;
        if (backupSha256 !== observed.sha256) {
          throw new WebAuthorityError("WEB_AUTHORITY_OPERATIONAL_ERROR", `Backup verification failed: ${prepared.relative_path}`);
        }
      }
      journal.backups.push({
        operation_index: index,
        relative_path: prepared.relative_path,
        original_sha256: observed.sha256,
        backup_relative_path: backupRelativePath,
        backup_sha256: backupSha256,
      });
      journal.updated_at = new Date().toISOString();
      await writeJournal(journalPath, journal);

      const payload = payloadForOperation(options.pack, operation);
      if (operation.kind === "delete_file") {
        await fs.unlink(target);
      } else {
        await atomicWrite(target, payload!);
      }

      const postimage = await readObservedPreimage(root, prepared.relative_path);
      const expectedPostimage = operation.kind === "delete_file" ? null : prepared.payload_sha256;
      if (postimage.sha256 !== expectedPostimage) {
        throw new WebAuthorityError("WEB_AUTHORITY_OPERATIONAL_ERROR", `Postimage verification failed: ${prepared.relative_path}`);
      }
      journal.completed_operation_indexes.push(index);
      journal.updated_at = new Date().toISOString();
      await writeJournal(journalPath, journal);
    }

    journal.status = "committed";
    journal.updated_at = new Date().toISOString();
    await writeJournal(journalPath, journal);
    return {
      journal_path: journalPath,
      status: "committed",
      plan_sha256: options.plan.plan_sha256,
      applied_operations: options.plan.operations.length,
    };
  } catch (error) {
    await recoverWebOperationTransaction({ journalPath }).catch(() => undefined);
    throw error;
  }
}
