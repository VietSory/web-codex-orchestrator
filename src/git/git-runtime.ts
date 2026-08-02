import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { GitBoundaryError } from "./contracts.js";

export interface GitRuntime {
  root: string;
  hooksPath: string;
  globalConfigPath: string;
}
async function ensureDirectory(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new GitBoundaryError("WORKTREE_PATH_UNSAFE", "Git runtime path must be a real directory.");
    }
    return;
  } catch (error) {
    if (error instanceof GitBoundaryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(target, { recursive: false, mode: 0o700 });
  const created = await lstat(target);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new GitBoundaryError("WORKTREE_PATH_UNSAFE", "Git runtime path is unsafe.");
  }
}

async function ensureEmptyFile(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new GitBoundaryError("WORKTREE_PATH_UNSAFE", "Git runtime config must be a regular file.");
    }
    return;
  } catch (error) {
    if (error instanceof GitBoundaryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  await handle.close();
}

/**
 * Creates the process-local Git runtime used by preparation. It prevents
 * system/global configuration and hooks from selecting user programs.
 */
export async function ensureGitRuntime(stateDirectory: string): Promise<GitRuntime> {
  const root = path.join(path.resolve(stateDirectory), "git-runtime");
  const hooksPath = path.join(root, "empty-hooks");
  const globalConfigPath = path.join(root, "empty-config");
  await ensureDirectory(root);
  await ensureDirectory(hooksPath);
  await ensureEmptyFile(globalConfigPath);
  return { root, hooksPath, globalConfigPath };
}
