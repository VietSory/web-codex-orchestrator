export type DraftPullRequestState =
  | "READY_FOR_CREATE"
  | "CREATE_UNCERTAIN"
  | "OPEN"
  | "CONFLICT";

export type DraftPullRequestErrorCode =
  | "PR_REQUEST_INVALID"
  | "PR_CONFIG_INVALID"
  | "PR_PHASE5A_NOT_PUSHED"
  | "PR_PUBLISH_RECEIPT_INCONSISTENT"
  | "PR_REMOTE_UNSUPPORTED"
  | "PR_REMOTE_BRANCH_MISMATCH"
  | "PR_BASE_BRANCH_MISSING"
  | "PR_AUTH_UNAVAILABLE"
  | "PR_API_UNAUTHORIZED"
  | "PR_API_FORBIDDEN"
  | "PR_API_NOT_FOUND"
  | "PR_API_RATE_LIMITED"
  | "PR_API_REDIRECT_REJECTED"
  | "PR_API_RESPONSE_TOO_LARGE"
  | "PR_API_RESPONSE_INVALID"
  | "PR_API_FAILED"
  | "PR_CREATE_REJECTED"
  | "PR_CREATE_UNCERTAIN"
  | "PR_EXISTING_CONFLICT"
  | "PR_RECEIPT_INVALID"
  | "PR_RECEIPT_INCONSISTENT";

export class DraftPullRequestError extends Error {
  public readonly code: DraftPullRequestErrorCode;
  public readonly details: string;

  constructor(code: DraftPullRequestErrorCode, details: string) {
    super(`${code}: ${details}`);
    this.name = "DraftPullRequestError";
    this.code = code;
    this.details = details;
  }
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  merged_at: string | null;
  title: string;
  body: string | null;
  head: {
    ref: string;
    sha: string;
    repo: { full_name: string } | null;
  };
  base: {
    ref: string;
    sha: string;
    repo: { full_name: string } | null;
  };
}

export interface GitHubPullRequestClient {
  listByHead(input: {
    owner: string;
    repository: string;
    headOwner: string;
    headBranch: string;
  }): Promise<GitHubPullRequest[]>;

  get(input: {
    owner: string;
    repository: string;
    pullNumber: number;
  }): Promise<GitHubPullRequest>;

  createDraft(input: {
    owner: string;
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<GitHubPullRequest>;
}

export interface DraftPullRequestReceipt {
  receipt_version: "1.0";
  run_id: string;
  state: DraftPullRequestState;
  repository_owner: string;
  repository_name: string;
  base_branch: string;
  head_branch: string;
  expected_head_sha: string;
  git_publish_receipt_sha256: string;
  request_sha256: string;
  title: string;
  body_sha256: string;
  draft_required: true;
  create_post_attempted: boolean;
  pull_number: number | null;
  pull_url: string | null;
  observed_head_sha: string | null;
  observed_base_branch: string | null;
  observed_state: "open" | "closed" | null;
  observed_draft: boolean | null;
  conflict_reason:
    | "MULTIPLE_CANDIDATES"
    | "WRONG_REPOSITORY"
    | "WRONG_BASE"
    | "WRONG_HEAD_BRANCH"
    | "WRONG_HEAD_SHA"
    | "NOT_OPEN"
    | "NOT_DRAFT"
    | "MERGED"
    | "INVALID_CREATE_RESPONSE"
    | "OPEN_PR_MUTATED"
    | null;
  created_at: string;
  updated_at: string;
  create_attempted_at: string | null;
  opened_at: string | null;
  conflict_at: string | null;
}
