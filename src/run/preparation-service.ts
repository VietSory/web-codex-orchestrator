import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { BundleManifest } from "../bundle/contracts.js";
import { loadTrustedConfig } from "../config/config-loader.js";
import { validateExecutionContract } from "../execution/execution-validator.js";
import type { ExecutionIssue } from "../execution/contracts.js";
import { GitBoundaryError, isGitBoundaryError, type CreatedWorktree } from "../git/contracts.js";
import { prepareBase } from "../git/base-commit.js";
import { validateBranchPolicy } from "../git/branch-policy.js";
import { GitRunner } from "../git/git-runner.js";
import { resolveRepository } from "../git/repository-resolver.js";
import { verifyRemote } from "../git/remote-verifier.js";
import { createIsolatedWorktree } from "../git/worktree-manager.js";
import { intakeArchive, type IntakeOptions } from "../intake/intake-service.js";
import type { AcceptedIntakeReceipt, IntakeReceipt } from "../intake/contracts.js";
import { appendRunEvent } from "./event-journal.js";
import { acquireExclusiveLock, runLockPath, type LockHandle } from "./locks.js";
import type { PreparationResult, RunReceipt, RunState } from "./contracts.js";
import { readRunReceipt, runDirectory, writeRunReceipt } from "./run-store.js";

export type PreparationErrorCode =
  | "EXECUTION_CONTRACT_REQUIRED"
  | "DELIVERY_CONTRACT_INVALID"
  | "GIT_POLICY_INVALID"
  | "REPOSITORY_NOT_REGISTERED"
  | "REPOSITORY_PATH_UNSAFE"
  | "REPOSITORY_NOT_GIT"
  | "REPOSITORY_BARE"
  | "REMOTE_NOT_FOUND"
  | "REMOTE_NOT_ALLOWED"
  | "REMOTE_URL_MISMATCH"
  | "FETCH_DISABLED"
  | "FETCH_FAILED"
  | "BASE_COMMIT_INVALID"
  | "BASE_COMMIT_NOT_FOUND"
  | "BASE_COMMIT_NOT_ANCESTOR"
  | "BRANCH_POLICY_VIOLATION"
  | "BRANCH_ALREADY_EXISTS"
  | "WORKTREE_PATH_UNSAFE"
  | "WORKTREE_ALREADY_EXISTS"
  | "WORKTREE_CREATE_FAILED"
  | "WORKTREE_VERIFY_FAILED"
  | "RUN_RECEIPT_INCONSISTENT"
  | "RUN_LOCKED"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_NOT_REGULAR_FILE"
  | "CONFIG_SYMLINK"
  | "CONFIG_INVALID"
  | "OPERATIONAL_ERROR"
  | string;

export class PreparationError extends Error {
  constructor(readonly code: PreparationErrorCode, message: string, readonly receipt?: IntakeReceipt | RunReceipt) {
    super(message);
    this.name = "PreparationError";
  }
}

export interface PreparationOptions {
  archivePath: string;
  stateDirectory: string;
  configPath: string;
  runner?: GitRunner;
  now?: () => Date;
  intakeOptions?: IntakeOptions;
}

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PreparationError("OPERATIONAL_ERROR", `Lifecycle path is not a real directory: ${directory}`);
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const created = await lstat(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new PreparationError("OPERATIONAL_ERROR", `Lifecycle path is unsafe: ${directory}`);
  }
}

async function ensurePhaseState(stateDirectory: string): Promise<void> {
  await ensureRealDirectory(stateDirectory);
  for (const name of ["quarantine", "accepted", "rejected", "runs", "worktrees", "locks"]) await ensureRealDirectory(path.join(stateDirectory, name));
}

export const ensurePhaseStateDirectory = ensurePhaseState;

function firstIssue(issues: ExecutionIssue[]): PreparationError {
  const issue = issues[0];
  return new PreparationError(issue?.code ?? "DELIVERY_CONTRACT_INVALID", issue?.message ?? "Invalid execution contract.");
}

function errorDetails(error: unknown): { code: PreparationErrorCode; message: string } {
  if (error instanceof PreparationError) return { code: error.code, message: error.message };
  if (isGitBoundaryError(error)) return { code: error.code, message: error.message };
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return { code: error.code, message: error instanceof Error ? error.message : String(error) };
  return { code: "OPERATIONAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}

function isBlockedCode(code: PreparationErrorCode): boolean {
  return code !== "OPERATIONAL_ERROR" && code !== "FETCH_FAILED" && code !== "WORKTREE_CREATE_FAILED" && code !== "WORKTREE_VERIFY_FAILED";
}

async function acceptedBundlePath(stateDirectory: string, receipt: AcceptedIntakeReceipt): Promise<string> {
  const acceptedRoot = path.resolve(stateDirectory, "accepted");
  const candidate = path.resolve(stateDirectory, receipt.stored_bundle);
  const relative = path.relative(acceptedRoot, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new PreparationError("OPERATIONAL_ERROR", "Accepted bundle path escapes accepted storage.");
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PreparationError("OPERATIONAL_ERROR", "Accepted bundle path is not a real directory.");
  const canonical = await realpath(candidate);
  const canonicalRoot = await realpath(acceptedRoot);
  const canonicalRelative = path.relative(canonicalRoot, canonical);
  if (!canonicalRelative || canonicalRelative.startsWith(`..${path.sep}`) || canonicalRelative === ".." || path.isAbsolute(canonicalRelative)) throw new PreparationError("OPERATIONAL_ERROR", "Accepted bundle real path escapes accepted storage.");
  return canonical;
}

async function verifyExistingRun(receipt: RunReceipt, stateDirectory: string, runner: GitRunner): Promise<void> {
  if (receipt.status !== "READY_FOR_CODEX" || receipt.state !== "READY_FOR_CODEX") throw new PreparationError("RUN_RECEIPT_INCONSISTENT", "Existing run receipt is not complete.", receipt);
  const worktreesRoot = path.resolve(stateDirectory, "worktrees");
  const candidate = path.resolve(receipt.worktree_path);
  const relative = path.relative(worktreesRoot, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new PreparationError("RUN_RECEIPT_INCONSISTENT", "Existing worktree path escapes state-dir/worktrees.", receipt);
  const info = await lstat(candidate).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new PreparationError("RUN_RECEIPT_INCONSISTENT", "Existing run worktree is missing or unsafe.", receipt);
  const head = await runner.run(["rev-parse", "HEAD"], candidate);
  const branch = await runner.run(["branch", "--show-current"], candidate);
  const status = await runner.run(["status", "--porcelain"], candidate);
  if (head.exitCode !== 0 || head.stdout.trim() !== receipt.base_commit || branch.exitCode !== 0 || branch.stdout.trim() !== receipt.branch_name || status.exitCode !== 0 || status.stdout.trim() !== "") throw new PreparationError("RUN_RECEIPT_INCONSISTENT", "Existing run receipt does not match the actual worktree.", receipt);
}

async function removeCreatedWorktree(worktree: CreatedWorktree | undefined, repositoryPath: string, runner: GitRunner): Promise<void> {
  if (!worktree?.created) return;
  await runner.run(["worktree", "remove", "--force", worktree.path], repositoryPath);
  await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
  await runner.run(["branch", "-D", worktree.branch_name], repositoryPath);
}

function newReceipt(
  accepted: AcceptedIntakeReceipt,
  now: () => Date,
): RunReceipt {
  const timestamp = now().toISOString();
  return {
    run_version: "1.0",
    run_id: `${accepted.task_id}:${accepted.archive_sha256}`,
    status: "ACCEPTED",
    task_id: accepted.task_id,
    archive_sha256: accepted.archive_sha256,
    bundle_schema_version: "1.2",
    repository_id: "",
    repository_path: "",
    remote: "",
    remote_url: "",
    base_branch: "",
    base_commit: "",
    branch_name: "",
    worktree_path: "",
    accepted_bundle_path: accepted.stored_bundle,
    state: "ACCEPTED",
    checks: ["bundle-intake-accepted"],
    errors: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function prepareTask(options: PreparationOptions): Promise<PreparationResult> {
  const stateDirectory = path.resolve(options.stateDirectory);
  const now = options.now ?? (() => new Date());
  const runner = options.runner ?? new GitRunner();
  await ensurePhaseState(stateDirectory);
  let intake: IntakeReceipt;
  try {
    intake = await intakeArchive(options.archivePath, stateDirectory, options.intakeOptions);
  } catch (error) {
    throw new PreparationError("OPERATIONAL_ERROR", error instanceof Error ? error.message : String(error));
  }
  if (intake.status !== "accepted") {
    const issue = intake.errors[0];
    throw new PreparationError(issue?.code ?? "OPERATIONAL_ERROR", issue?.message ?? "Bundle intake was rejected.", intake);
  }
  if (intake.bundle_schema_version !== "1.2") throw new PreparationError("EXECUTION_CONTRACT_REQUIRED", "Only schema 1.2 bundles may be prepared.", intake);

  const lock: LockHandle = await acquireExclusiveLock(runLockPath(stateDirectory, intake.archive_sha256), "RUN_LOCKED");
  let worktree: CreatedWorktree | undefined;
  let repositoryPath: string | undefined;
  let preserveExistingRun = false;
  let branchLock: LockHandle | undefined;
  let receipt = newReceipt(intake, now);
  try {
    let existing: RunReceipt | undefined;
    try {
      existing = await readRunReceipt(stateDirectory, intake.task_id, intake.archive_sha256);
      const runPathInfo = await lstat(runDirectory(stateDirectory, intake.task_id, intake.archive_sha256)).catch(() => undefined);
      if (runPathInfo && (!runPathInfo.isDirectory() || runPathInfo.isSymbolicLink()) || runPathInfo && !existing) {
        preserveExistingRun = true;
        throw new PreparationError("RUN_RECEIPT_INCONSISTENT", "Existing run directory has no valid receipt.");
      }
    } catch (error) {
      if (error instanceof PreparationError) { preserveExistingRun = true; throw error; }
      throw new PreparationError("RUN_RECEIPT_INCONSISTENT", `Existing run receipt cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (existing) {
      await verifyExistingRun(existing, stateDirectory, runner);
      return existing as PreparationResult;
    }
    const bundleDirectory = await acceptedBundlePath(stateDirectory, intake);
    receipt.accepted_bundle_path = bundleDirectory;
    await writeRunReceipt(stateDirectory, receipt);
    const manifest = JSON.parse(await readFile(path.join(bundleDirectory, "manifest.json"), "utf8")) as BundleManifest;
    const execution = validateExecutionContract(manifest);
    if (!execution.ok || !execution.contract) throw firstIssue(execution.issues);
    receipt.repository_id = execution.contract.repository.id;
    receipt.base_branch = execution.contract.repository.base_branch;
    receipt.base_commit = execution.contract.repository.base_commit;
    receipt.branch_name = execution.contract.delivery.branch_name;
    const branchDigest = createHash("sha256").update(receipt.branch_name).digest("hex");
    branchLock = await acquireExclusiveLock(path.join(stateDirectory, "locks", `branch-${branchDigest}.lock`), "RUN_LOCKED");
    await appendRunEvent(stateDirectory, receipt.task_id, receipt.archive_sha256, receipt.run_id, "ACCEPTED", "RESOLVING_REPOSITORY", {}, now);
    receipt.status = "RESOLVING_REPOSITORY"; receipt.state = "RESOLVING_REPOSITORY"; receipt.updated_at = now().toISOString();
    await writeRunReceipt(stateDirectory, receipt);

    const config = await loadTrustedConfig(options.configPath);
    const repository = await resolveRepository(config, execution.contract.repository.id, runner);
    repositoryPath = repository.path;
    receipt.repository_path = repository.path;
    receipt.remote = repository.remote;
    receipt.checks.push("execution-contract-valid", "repository-registered");
    if (execution.contract.delivery.remote !== repository.remote) throw new GitBoundaryError("REMOTE_NOT_ALLOWED", "Manifest remote does not match the trusted registry.");
    const remote = await verifyRemote(repository, runner);
    receipt.remote_url = remote.matched_url;
    receipt.checks.push("remote-verified");
    await validateBranchPolicy(execution.contract.delivery.branch_name, execution.contract.git_policy.allowed_branch_prefix, execution.contract.git_policy.deny_direct_push_branches, repository, runner);
    receipt.status = "FETCHING_BASE"; receipt.state = "FETCHING_BASE"; receipt.updated_at = now().toISOString();
    await appendRunEvent(stateDirectory, receipt.task_id, receipt.archive_sha256, receipt.run_id, "RESOLVING_REPOSITORY", "FETCHING_BASE", {}, now);
    await writeRunReceipt(stateDirectory, receipt);
    const base = await prepareBase(repository, execution.contract.repository.base_branch, execution.contract.repository.base_commit, runner);
    receipt.status = "VERIFYING_BASE"; receipt.state = "VERIFYING_BASE"; receipt.updated_at = now().toISOString();
    await appendRunEvent(stateDirectory, receipt.task_id, receipt.archive_sha256, receipt.run_id, "FETCHING_BASE", "VERIFYING_BASE", { trusted_ref: base.trusted_ref, fetched: base.fetched }, now);
    receipt.checks.push("base-commit-verified");
    await writeRunReceipt(stateDirectory, receipt);
    receipt.status = "CREATING_WORKTREE"; receipt.state = "CREATING_WORKTREE"; receipt.updated_at = now().toISOString();
    await appendRunEvent(stateDirectory, receipt.task_id, receipt.archive_sha256, receipt.run_id, "VERIFYING_BASE", "CREATING_WORKTREE", {}, now);
    await writeRunReceipt(stateDirectory, receipt);
    worktree = await createIsolatedWorktree({ stateDirectory, taskId: receipt.task_id, archiveSha256: receipt.archive_sha256, branchName: execution.contract.delivery.branch_name, baseCommit: execution.contract.repository.base_commit, repository, runner });
    receipt.worktree_path = worktree.path;
    receipt.status = "VERIFYING_WORKTREE"; receipt.state = "VERIFYING_WORKTREE"; receipt.updated_at = now().toISOString();
    await appendRunEvent(stateDirectory, receipt.task_id, receipt.archive_sha256, receipt.run_id, "CREATING_WORKTREE", "VERIFYING_WORKTREE", {}, now);
    receipt.checks.push("worktree-created", "worktree-clean");
    await writeRunReceipt(stateDirectory, receipt);
    receipt.status = "READY_FOR_CODEX"; receipt.state = "READY_FOR_CODEX"; receipt.updated_at = now().toISOString();
    await appendRunEvent(stateDirectory, receipt.task_id, receipt.archive_sha256, receipt.run_id, "VERIFYING_WORKTREE", "READY_FOR_CODEX", {}, now);
    await writeRunReceipt(stateDirectory, receipt);
    return receipt as PreparationResult;
  } catch (error) {
    if (preserveExistingRun || error instanceof PreparationError && error.code === "RUN_RECEIPT_INCONSISTENT" && error.receipt && "run_id" in error.receipt) {
      throw error;
    }
    const detail = errorDetails(error);
    const previousState = receipt.state;
    receipt.errors = [{ code: detail.code, message: detail.message }];
    receipt.status = isBlockedCode(detail.code) ? "BLOCKED" : "FAILED";
    receipt.state = receipt.status;
    receipt.updated_at = now().toISOString();
    if (previousState !== receipt.status) await appendRunEvent(stateDirectory, receipt.task_id, receipt.archive_sha256, receipt.run_id, previousState, receipt.status, {}, now).catch(() => undefined);
    await writeRunReceipt(stateDirectory, receipt).catch(() => undefined);
    if (repositoryPath) await removeCreatedWorktree(worktree, repositoryPath, runner).catch(() => undefined);
    throw new PreparationError(detail.code, detail.message, receipt);
  } finally {
    await branchLock?.release();
    await lock.release();
  }
}

export const prepareBundle = prepareTask;
