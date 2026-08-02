import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { CreatedWorktree, GitCommandResult, ResolvedRepository } from "./contracts.js";
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

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
  if (await exists(worktreePath)) throw new GitBoundaryError("WORKTREE_ALREADY_EXISTS", "Final worktree path already exists.");

  const branchRef = `refs/heads/${options.branchName}`;
  const branch = await runner.run(["show-ref", "--verify", "--quiet", branchRef], options.repository.path);
  if (branch.exitCode === 0) throw new GitBoundaryError("BRANCH_ALREADY_EXISTS", "Branch already exists.", branch);

  let attempted = false;
  try {
    attempted = true;
    const added = await runner.run(["worktree", "add", "-b", options.branchName, worktreePath, options.baseCommit], options.repository.path);
    if (added.exitCode !== 0) throw failed("WORKTREE_CREATE_FAILED", "Git worktree creation failed.", added);

    const canonicalWorktree = await realpath(worktreePath);
    if (!contained(worktreesRoot, canonicalWorktree)) throw failed("WORKTREE_VERIFY_FAILED", "Resolved worktree path escapes state-dir/worktrees.");
    const head = await runner.run(["rev-parse", "HEAD"], canonicalWorktree);
    if (head.exitCode !== 0 || head.stdout.trim() !== options.baseCommit) throw failed("WORKTREE_VERIFY_FAILED", "Worktree HEAD does not match the requested base commit.", head);
    const currentBranch = await runner.run(["branch", "--show-current"], canonicalWorktree);
    if (currentBranch.exitCode !== 0 || currentBranch.stdout.trim() !== options.branchName) throw failed("WORKTREE_VERIFY_FAILED", "Worktree branch does not match the requested branch.", currentBranch);
    const status = await runner.run(["status", "--porcelain"], canonicalWorktree);
    if (status.exitCode !== 0 || status.stdout.trim() !== "") throw failed("WORKTREE_VERIFY_FAILED", "New worktree is not clean.", status);
    const listed = await runner.run(["worktree", "list", "--porcelain"], options.repository.path);
    if (listed.exitCode !== 0 || !listed.stdout.split(/\r?\n/).some((line) => line === `worktree ${canonicalWorktree}`)) throw failed("WORKTREE_VERIFY_FAILED", "New worktree is not present in git worktree list.", listed);
    return { path: canonicalWorktree, branch_name: options.branchName, base_commit: options.baseCommit, created: true };
  } catch (error) {
    if (attempted) {
      const removed = await runner.run(["worktree", "remove", "--force", worktreePath], options.repository.path);
      if (await exists(worktreePath)) await rm(worktreePath, { recursive: true, force: true });
      await runner.run(["branch", "-D", options.branchName], options.repository.path);
      if (removed.exitCode !== 0) {
        // The primary failure remains the useful error; cleanup details are not
        // exposed as credentials or environment values.
      }
    }
    if (error instanceof GitBoundaryError) throw error;
    throw failed("WORKTREE_CREATE_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export const createWorktree = createIsolatedWorktree;
