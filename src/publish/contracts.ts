export type GitPublishState = "READY_FOR_COMMIT" | "COMMITTED" | "PUSHED";

export type GitPublishErrorCode =
  | "PUBLISH_REQUEST_INVALID"
  | "PUBLISH_RECEIPT_INVALID"
  | "PUBLISH_RECEIPT_INCONSISTENT"
  | "PUBLISH_WORKTREE_UNSAFE"
  | "PUBLISH_BASE_MISMATCH"
  | "PUBLISH_BRANCH_POLICY_VIOLATION"
  | "PUBLISH_REMOTE_MISMATCH"
  | "PUBLISH_PHASE4_NOT_READY"
  | "PUBLISH_CHANGE_SET_STALE"
  | "PUBLISH_APPROVED_SNAPSHOT_MISSING"
  | "PUBLISH_STAGE_MISMATCH"
  | "PUBLISH_INDEX_MISMATCH"
  | "PUBLISH_COMMIT_MISMATCH"
  | "PUBLISH_RECOVERY_FAILED"
  | "PUBLISH_COMMIT_FAILED"
  | "PUBLISH_REMOTE_BRANCH_EXISTS"
  | "PUBLISH_PUSH_FAILED"
  | "PUBLISH_REMOTE_VERIFICATION_FAILED"
  | "PUBLISH_IDENTITY_UNAVAILABLE"
  | "PUBLISH_AUTH_UNAVAILABLE"
  | "PUBLISH_AUTH_FAILED"
  | "PUBLISH_PUSH_PREFLIGHT_FAILED";

export class GitPublishError extends Error {
  readonly code: GitPublishErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: GitPublishErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GitPublishError";
    this.code = code;
    this.details = details;
  }
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string | null;
}

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult>;
}

export interface VerifiedChangeSet {
  change_set_sha256: string;
  paths: string[];
}

export interface GitPublishRequest {
  run_id: string;
  worktree_path: string;
  base_commit: string;
  branch_name: string;
  remote_name: string;
  allowed_remote_url: string;
  allowed_branch_prefix: string;
  deny_direct_push_branches: string[];
  expected_change_set_sha256: string;
  expected_paths: string[];
  commit_message: string;
  allow_force_push: false;
  allow_remote_branch_delete: false;
}

export interface GitPublishReceipt {
  publish_version: "1.1";
  run_id: string;
  state: GitPublishState;
  base_commit: string;
  branch_name: string;
  remote_name: string;
  allowed_remote_url: string;
  change_set_sha256: string;
  expected_paths: string[];
  approved_snapshot_sha256: string;
  commit_sha: string | null;
  remote_branch_sha: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
  pushed_at: string | null;
}

export interface GitPublisherOptions {
  runner: GitCommandRunner;
  inspectVerifiedChangeSet: () => Promise<VerifiedChangeSet>;
  persistReceipt: (receipt: GitPublishReceipt) => Promise<void>;
  now?: () => Date;
  realpath?: (value: string) => Promise<string>;
}
