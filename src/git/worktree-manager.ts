import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { CleanupError, CreatedWorktree, GitCommandResult, ResolvedRepository } from "./contracts.js";
import { GitBoundaryError } from "./contracts.js";
import { GitRunner } from "./git-runner.js";

async function ensureDirectory(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new GitBoundaryError("WORKTREE_PATH_UNSAFE", `Worktree lifecycle path is not a real directory: ${target}`);
    return;
  } catch (error) {
    if (error instanceof GitBoundaryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(target, { recursive: false, mode: 0o700 });
  const created = await lstat(target);
  if (created.isSymbolicLink() || !created.isDirectory()) throw new GitBoundaryError("WORKTREE_PATH_UNSAFE", `Worktree lifecycle path is unsafe: ${target}`);
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function failed(code: "WORKTREE_CREATE_FAILED" | "WORKTREE_VERIFY_FAILED", message: string, result?: GitCommandResult): GitBoundaryError {
  return new GitBoundaryError(code, message, result);
}

export interface WorktreeOptions {
  stateDirectory: string;
  taskId: string;
  archiveSha256: string;
  branchName: string;
  baseCommit: string;
  repository: ResolvedRepository;
  runner?: GitRunner;
  hooksDirectory?: string;
}

function protectedArguments(hooksDirectory: string): string[] {
  return ["-c", `core.hooksPath=${hooksDirectory}`, "-c", "core.fsmonitor=false"];
}

async function inspectCheckoutFilters(repository: ResolvedRepository, runner: GitRunner): Promise<void> {
  const result = await runner.run(
    ["config", "--show-origin", "--get-regexp", "^filter\\..*\\.(smudge|process|required)$"],
    repository.path,
  );
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    throw new GitBoundaryError(
      "GIT_CHECKOUT_FILTER_UNSAFE",
      "Repository checkout filters are not allowed during preparation.",
      result,
    );
  }
  // git config returns 1 when no matching key exists. Any other failure means
  // the effective configuration could not be inspected safely.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw failed("WORKTREE_CREATE_FAILED", "Git checkout configuration could not be inspected.", result);
  }
}

async function safeRemoveWorktreePath(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    // Never follow a replacement symlink during cleanup.
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) await rm(target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function cleanupCreatedResources(
  options: WorktreeOptions,
  runner: GitRunner,
  worktreePath: string,
  branchCreated: boolean,
  branchTip: string | undefined,
  worktreeAdded: boolean,
): Promise<CleanupError[]> {
  const errors: CleanupError[] = [];
  if (worktreeAdded) {
    const removed = await runner.run(
      [...protectedArguments(options.hooksDirectory ?? path.join(path.resolve(options.stateDirectory), "git-runtime", "empty-hooks")), "worktree", "remove", "--force", worktreePath],
      options.repository.path,
    ).catch((error: unknown) => {
      errors.push({ action: "worktree-remove", message: error instanceof Error ? error.message : "Git worktree removal failed." });
      return undefined;
    });
    if (removed && removed.exitCode !== 0) errors.push({ action: "worktree-remove", message: "Git worktree removal failed." });
    try {
      await safeRemoveWorktreePath(worktreePath);
    } catch {
      errors.push({ action: "worktree-path-remove", message: "Worktree path cleanup failed." });
    }
  }
  if (branchCreated) {
    const branchRef = `refs/heads/${options.branchName}`;
    const current = await runner.run(["rev-parse", "--verify", branchRef], options.repository.path).catch(() => undefined);
    if (!current || current.exitCode !== 0 || (branchTip !== undefined && current.stdout.trim() !== branchTip)) {
      errors.push({ action: "branch-remove", message: "Created branch changed before cleanup; it was preserved." });
    } else {
      const removed = await runner.run(["branch", "-D", options.branchName], options.repository.path).catch(() => undefined);
      if (!removed || removed.exitCode !== 0) errors.push({ action: "branch-remove", message: "Created branch cleanup failed." });
    }
  }
  return errors;
}

export async function createIsolatedWorktree(options: WorktreeOptions): Promise<CreatedWorktree> {
  const runner = options.runner ?? new GitRunner();
  const stateDirectory = path.resolve(options.stateDirectory);
  const worktreesRoot = path.join(stateDirectory, "worktrees");
  const taskRoot = path.join(worktreesRoot, options.taskId);
  const archiveRoot = path.join(taskRoot, options.archiveSha256);
  const worktreePath = path.join(archiveRoot, "repository");
  if (!contained(worktreesRoot, worktreePath)) throw new GitBoundaryError("WORKTREE_PATH_UNSAFE", "Worktree path escapes state-dir/worktrees.");
  if (contained(options.repository.path, worktreePath)) throw new GitBoundaryError("WORKTREE_PATH_UNSAFE", "Worktree must not be created inside the target repository.");
  await ensureDirectory(stateDirectory);
  await ensureDirectory(worktreesRoot);
  await ensureDirectory(taskRoot);
  await ensureDirectory(archiveRoot);
  try {
    const existing = await lstat(worktreePath);
    if (existing.isSymbolicLink()) throw new GitBoundaryError("WORKTREE_PATH_UNSAFE", "Final worktree path must not be a symbolic link.");
    throw new GitBoundaryError("WORKTREE_ALREADY_EXISTS", "Final worktree path already exists.");
  } catch (error) {
    if (error instanceof GitBoundaryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const branchRef = `refs/heads/${options.branchName}`;
  const branch = await runner.run(["show-ref", "--verify", "--quiet", branchRef], options.repository.path);
  if (branch.exitCode === 0) throw new GitBoundaryError("BRANCH_ALREADY_EXISTS", "Branch already exists.", branch);

  const hooksDirectory = options.hooksDirectory ?? path.join(stateDirectory, "git-runtime", "empty-hooks");
  await ensureDirectory(path.dirname(hooksDirectory));
  await ensureDirectory(hooksDirectory);
  await inspectCheckoutFilters(options.repository, runner);

  let worktreeAdded = false;
  let branchCreated = false;
  let branchTip: string | undefined;
  try {
    // First create an unpopulated detached worktree. This gives the operation
    // a resource it can own before attempting the task branch, so a branch
    // appearing in the race window is never deleted by cleanup.
    const added = await runner.run([
      ...protectedArguments(hooksDirectory),
      "worktree", "add", "--detach", "--no-checkout", worktreePath, options.baseCommit,
    ], options.repository.path);
    if (added.exitCode !== 0) throw failed("WORKTREE_CREATE_FAILED", "Git worktree creation failed.", added);
    worktreeAdded = true;

    const canonicalWorktree = await realpath(worktreePath);
    if (!contained(worktreesRoot, canonicalWorktree)) throw failed("WORKTREE_VERIFY_FAILED", "Resolved worktree path escapes state-dir/worktrees.");
    const owned = await runner.run(["worktree", "list", "--porcelain"], options.repository.path);
    if (owned.exitCode !== 0 || !owned.stdout.split(/\r?\n/).some((line) => line === `worktree ${canonicalWorktree}`)) {
      throw failed("WORKTREE_VERIFY_FAILED", "New worktree ownership could not be verified.", owned);
    }

    const createdBranch = await runner.run(["branch", options.branchName, options.baseCommit], options.repository.path);
    if (createdBranch.exitCode !== 0) {
      const code = /already exists|a branch named/i.test(`${createdBranch.stdout}\n${createdBranch.stderr}`)
        ? "BRANCH_ALREADY_EXISTS"
        : "WORKTREE_CREATE_FAILED";
      throw new GitBoundaryError(code, code === "BRANCH_ALREADY_EXISTS" ? "Branch already exists." : "Task branch creation failed.", createdBranch);
    }
    branchCreated = true;
    const branchRefResult = await runner.run(["rev-parse", "--verify", `refs/heads/${options.branchName}`], options.repository.path);
    if (branchRefResult.exitCode !== 0 || branchRefResult.stdout.trim().length === 0) throw failed("WORKTREE_VERIFY_FAILED", "Created branch could not be verified.", branchRefResult);
    branchTip = branchRefResult.stdout.trim();

    // Point the detached worktree HEAD at the branch without invoking a
    // checkout. No repository files, hooks, or filters are executed.
    const attached = await runner.run([
      ...protectedArguments(hooksDirectory),
      "symbolic-ref", "HEAD", `refs/heads/${options.branchName}`,
    ], canonicalWorktree);
    if (attached.exitCode !== 0) throw failed("WORKTREE_VERIFY_FAILED", "Worktree branch attachment failed.", attached);

    // Populate the index and materialize tracked bytes without invoking a
    // checkout hook. External smudge/process filters were rejected above.
    const indexed = await runner.run([
      ...protectedArguments(hooksDirectory),
      "read-tree", "HEAD",
    ], canonicalWorktree);
    if (indexed.exitCode !== 0) throw failed("WORKTREE_VERIFY_FAILED", "Worktree index initialization failed.", indexed);
    const materialized = await runner.run([
      ...protectedArguments(hooksDirectory),
      "checkout-index", "--all", "--force",
    ], canonicalWorktree);
    if (materialized.exitCode !== 0) throw failed("WORKTREE_VERIFY_FAILED", "Worktree materialization failed.", materialized);

    const head = await runner.run([...protectedArguments(hooksDirectory), "rev-parse", "HEAD"], canonicalWorktree);
    if (head.exitCode !== 0 || head.stdout.trim() !== options.baseCommit) throw failed("WORKTREE_VERIFY_FAILED", "Worktree HEAD does not match the requested base commit.", head);
    const currentBranch = await runner.run([...protectedArguments(hooksDirectory), "branch", "--show-current"], canonicalWorktree);
    if (currentBranch.exitCode !== 0 || currentBranch.stdout.trim() !== options.branchName) throw failed("WORKTREE_VERIFY_FAILED", "Worktree branch does not match the requested branch.", currentBranch);
    const status = await runner.run([...protectedArguments(hooksDirectory), "status", "--porcelain"], canonicalWorktree);
    if (status.exitCode !== 0 || status.stdout.trim() !== "") throw failed("WORKTREE_VERIFY_FAILED", "New worktree is not clean.", status);
    const listed = await runner.run(["worktree", "list", "--porcelain"], options.repository.path);
    if (listed.exitCode !== 0 || !listed.stdout.split(/\r?\n/).some((line) => line === `worktree ${canonicalWorktree}`)) throw failed("WORKTREE_VERIFY_FAILED", "New worktree is not present in git worktree list.", listed);
    return { path: canonicalWorktree, branch_name: options.branchName, base_commit: options.baseCommit, created: true, ...(branchTip ? { branch_tip: branchTip } : {}) };
  } catch (error) {
    const cleanupErrors = await cleanupCreatedResources(options, runner, worktreePath, branchCreated, branchTip, worktreeAdded);
    if (error instanceof GitBoundaryError) {
      if (cleanupErrors.length > 0) throw new GitBoundaryError(error.code, error.message, error.result, cleanupErrors);
      throw error;
    }
    throw new GitBoundaryError("WORKTREE_CREATE_FAILED", error instanceof Error ? error.message : String(error), undefined, cleanupErrors);
  }
}

export const createWorktree = createIsolatedWorktree;
