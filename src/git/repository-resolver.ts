import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { TrustedConfig } from "../config/contracts.js";
import { GitBoundaryError, type ResolvedRepository } from "./contracts.js";
import { GitRunner } from "./git-runner.js";

function safeName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

export async function resolveRepository(
  config: TrustedConfig,
  repositoryId: string,
  runner = new GitRunner(),
): Promise<ResolvedRepository> {
  const registered = config.repositories[repositoryId];
  if (!registered) throw new GitBoundaryError("REPOSITORY_NOT_REGISTERED", `Repository is not registered: ${repositoryId}`);
  if (!safeName(registered.remote)) throw new GitBoundaryError("REPOSITORY_PATH_UNSAFE", "Configured remote name is unsafe.");
  let info;
  try {
    info = await lstat(registered.path);
  } catch (error) {
    throw new GitBoundaryError("REPOSITORY_PATH_UNSAFE", `Configured repository path cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new GitBoundaryError("REPOSITORY_PATH_UNSAFE", "Configured repository path must be a real directory.");
  let canonical: string;
  try {
    canonical = await realpath(registered.path);
  } catch (error) {
    throw new GitBoundaryError("REPOSITORY_PATH_UNSAFE", `Configured repository path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!path.isAbsolute(canonical)) throw new GitBoundaryError("REPOSITORY_PATH_UNSAFE", "Resolved repository path is not absolute.");

  const bare = await runner.run(["rev-parse", "--is-bare-repository"], canonical);
  if (bare.exitCode !== 0) throw new GitBoundaryError("REPOSITORY_NOT_GIT", "Configured path is not a Git repository.", bare);
  if (bare.stdout.trim() === "true") throw new GitBoundaryError("REPOSITORY_BARE", "Configured repository must not be bare.", bare);
  const worktree = await runner.run(["rev-parse", "--is-inside-work-tree"], canonical);
  if (worktree.exitCode !== 0 || worktree.stdout.trim() !== "true") throw new GitBoundaryError("REPOSITORY_NOT_GIT", "Configured path is not a Git worktree.", worktree);

  return {
    id: repositoryId,
    configured_path: path.resolve(registered.path),
    path: canonical,
    remote: registered.remote,
    expected_remote_urls: [...registered.expected_remote_urls],
    fetch_policy: registered.fetch_policy,
  };
}

export const resolveRegisteredRepository = resolveRepository;
