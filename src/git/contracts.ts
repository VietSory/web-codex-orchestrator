import type { FetchPolicy, RepositoryConfig } from "../config/contracts.js";

export type GitErrorCode =
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
  | "GIT_CHECKOUT_FILTER_UNSAFE"
  | "WORKTREE_PATH_UNSAFE"
  | "WORKTREE_ALREADY_EXISTS"
  | "WORKTREE_CREATE_FAILED"
  | "WORKTREE_VERIFY_FAILED"
  | "OPERATIONAL_ERROR";

export class GitBoundaryError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly result?: GitCommandResult,
    readonly cleanupErrors: CleanupError[] = [],
  ) {
    super(message);
    this.name = "GitBoundaryError";
  }
}

export interface CleanupError {
  action: string;
  message: string;
}

export interface GitCommandResult {
  executable: "git";
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out?: boolean;
  cancelled?: boolean;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

export interface ResolvedRepository {
  id: string;
  configured_path: string;
  path: string;
  remote: string;
  expected_remote_urls: string[];
  fetch_policy: FetchPolicy;
  remote_urls?: string[];
}

export interface VerifiedRemote {
  remote: string;
  urls: string[];
  matched_url: string;
}

export interface PreparedBase {
  base_commit: string;
  base_branch: string;
  trusted_ref: string;
  fetched: boolean;
}

export interface CreatedWorktree {
  path: string;
  branch_name: string;
  base_commit: string;
  created: boolean;
  branch_tip?: string;
}

export function isGitBoundaryError(error: unknown): error is GitBoundaryError {
  return error instanceof GitBoundaryError;
}

export function isSafeGitArgument(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !/[\u0000\r\n]/.test(value);
}

export function assertRepositoryConfig(value: unknown): asserts value is RepositoryConfig {
  if (!value || typeof value !== "object") throw new GitBoundaryError("REPOSITORY_NOT_REGISTERED", "Repository is not registered.");
}
