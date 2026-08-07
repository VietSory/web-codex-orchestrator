// Result Bundle contracts for deterministic output handoff.

export type ResultBundleState =
  | "READY_TO_BUILD" | "BUILDING" | "BUILT" | "VERIFIED" | "READY_FOR_WEB_REVIEW"
  | "BLOCKED" | "RETRYABLE" | "FAILED";

export type ResultBundleErrorCode =
  | "RESULT_REQUEST_INVALID" | "RESULT_CONFIG_INVALID" | "RESULT_STATE_DIR_UNSAFE"
  | "RESULT_EXECUTION_NOT_READY" | "RESULT_EXECUTION_RECEIPT_INVALID" | "RESULT_EXECUTION_RECEIPT_INCONSISTENT"
  | "RESULT_BUNDLE_MUTATED" | "RESULT_CHANGE_SET_STALE" | "RESULT_PUBLISH_NOT_PUSHED"
  | "RESULT_PUBLISH_RECEIPT_INVALID" | "RESULT_PUBLISH_RECEIPT_INCONSISTENT" | "RESULT_REMOTE_SHA_MISMATCH"
  | "RESULT_PR_NOT_OPEN" | "RESULT_PR_RECEIPT_INVALID" | "RESULT_PR_RECEIPT_INCONSISTENT"
  | "RESULT_PR_AUTH_UNAVAILABLE" | "RESULT_PR_API_UNAUTHORIZED" | "RESULT_PR_API_FORBIDDEN"
  | "RESULT_PR_API_NOT_FOUND" | "RESULT_PR_API_RATE_LIMITED" | "RESULT_PR_API_REDIRECT_REJECTED"
  | "RESULT_PR_API_RESPONSE_TOO_LARGE" | "RESULT_PR_API_RESPONSE_INVALID" | "RESULT_PR_API_FAILED"
  | "RESULT_PR_IDENTITY_MISMATCH" | "RESULT_PR_MERGED" | "RESULT_GIT_INSPECTION_FAILED"
  | "RESULT_DIFF_MISMATCH" | "RESULT_UNSUPPORTED_CHANGE_TYPE" | "RESULT_SOURCE_PATH_UNSAFE"
  | "RESULT_SOURCE_CONTENT_MISMATCH" | "RESULT_SOURCE_FILE_TOO_LARGE" | "RESULT_SENSITIVE_VALUE_DETECTED"
  | "RESULT_ARCHIVE_ENTRY_LIMIT" | "RESULT_ARCHIVE_SIZE_LIMIT" | "RESULT_ARCHIVE_PATH_COLLISION"
  | "RESULT_ARCHIVE_BUILD_FAILED" | "RESULT_ARCHIVE_VERIFY_FAILED" | "RESULT_OUTPUT_CONFLICT"
  | "RESULT_RECEIPT_INVALID" | "RESULT_RECEIPT_INCONSISTENT" | "RESULT_LOCKED" | "RESULT_STALE_LOCK"
  | "RESULT_INTERRUPTED" | "RESULT_BUNDLE_INVALID" | "RESULT_WEB_VERDICT_INVALID" | "RESULT_OPERATIONAL_ERROR";

export class ResultBundleError extends Error {
  readonly code: ResultBundleErrorCode;
  constructor(code: ResultBundleErrorCode, message: string) { super(message); this.name = "ResultBundleError"; this.code = code; }
}
export function isResultBundleError(error: unknown): error is ResultBundleError { return error instanceof ResultBundleError; }
export function resultBundleExitCode(code: ResultBundleErrorCode): number {
  const policy = new Set<ResultBundleErrorCode>([
    "RESULT_REQUEST_INVALID","RESULT_CONFIG_INVALID","RESULT_STATE_DIR_UNSAFE","RESULT_EXECUTION_NOT_READY","RESULT_PUBLISH_NOT_PUSHED",
    "RESULT_PR_API_UNAUTHORIZED","RESULT_PR_API_FORBIDDEN","RESULT_PR_API_REDIRECT_REJECTED","RESULT_PR_API_RESPONSE_TOO_LARGE",
    "RESULT_UNSUPPORTED_CHANGE_TYPE","RESULT_SOURCE_PATH_UNSAFE","RESULT_SOURCE_FILE_TOO_LARGE","RESULT_SENSITIVE_VALUE_DETECTED",
    "RESULT_ARCHIVE_ENTRY_LIMIT","RESULT_ARCHIVE_SIZE_LIMIT","RESULT_ARCHIVE_PATH_COLLISION","RESULT_BUNDLE_INVALID","RESULT_WEB_VERDICT_INVALID","RESULT_STALE_LOCK",
  ]);
  const integrity = new Set<ResultBundleErrorCode>([
    "RESULT_EXECUTION_RECEIPT_INVALID","RESULT_EXECUTION_RECEIPT_INCONSISTENT","RESULT_BUNDLE_MUTATED","RESULT_CHANGE_SET_STALE",
    "RESULT_PUBLISH_RECEIPT_INVALID","RESULT_PUBLISH_RECEIPT_INCONSISTENT","RESULT_REMOTE_SHA_MISMATCH","RESULT_PR_NOT_OPEN",
    "RESULT_PR_RECEIPT_INVALID","RESULT_PR_RECEIPT_INCONSISTENT","RESULT_PR_API_NOT_FOUND","RESULT_PR_API_RESPONSE_INVALID",
    "RESULT_PR_IDENTITY_MISMATCH","RESULT_PR_MERGED","RESULT_DIFF_MISMATCH","RESULT_SOURCE_CONTENT_MISMATCH",
    "RESULT_ARCHIVE_VERIFY_FAILED","RESULT_OUTPUT_CONFLICT","RESULT_RECEIPT_INVALID","RESULT_RECEIPT_INCONSISTENT",
  ]);
  const retryable = new Set<ResultBundleErrorCode>([
    "RESULT_PR_AUTH_UNAVAILABLE","RESULT_PR_API_RATE_LIMITED","RESULT_PR_API_FAILED","RESULT_GIT_INSPECTION_FAILED",
    "RESULT_ARCHIVE_BUILD_FAILED","RESULT_LOCKED","RESULT_INTERRUPTED","RESULT_OPERATIONAL_ERROR",
  ]);
  if (policy.has(code) || integrity.has(code)) return 1;
  if (retryable.has(code)) return 3;
  return 3;
}

export interface PullRequestAttestation {
  number: number;
  url: string;
  state: "open";
  draft: boolean;
  head_branch: string;
  head_sha: string;
  base_branch: string;
  title_sha256: string;
}

/**
 * v1.1 is the initial Phase 6 receipt. v1.2 adds an explicit revision input
 * chain so Phase 8 never aliases immutable revision evidence into Phase 6 fields.
 */
export interface ResultBundleReceipt {
  result_bundle_version: "1.1" | "1.2";
  input_kind?: "initial" | "revision";
  revision_round?: number | null;
  run_id: string;
  state: ResultBundleState;
  input_digest_sha256: string;
  execution_receipt_sha256: string;
  git_publish_receipt_sha256: string;
  draft_pr_receipt_sha256: string;
  revision_evidence_sha256?: string | null;
  revision_request_sha256?: string | null;
  previous_result_bundle_sha256?: string | null;
  previous_result_receipt_sha256?: string | null;
  previous_verdict_sha256?: string | null;
  previous_published_commit_sha?: string | null;
  previous_pr_head_sha?: string | null;
  accepted_bundle_tree_sha256: string;
  change_set_sha256: string;
  base_commit: string;
  published_commit_sha: string;
  remote_branch_sha: string;
  pull_request: PullRequestAttestation;
  archive_relative_path: string | null;
  archive_sha256: string | null;
  archive_size_bytes: number | null;
  entry_count: number | null;
  uncompressed_size_bytes: number | null;
  manifest_sha256: string | null;
  warnings: string[];
  created_at: string;
  updated_at: string;
  built_at: string | null;
  verified_at: string | null;
  ready_at: string | null;
  spec_set_sha256: string | null;
  review_contract_sha256: string | null;
  review_policy_sha256: string | null;
  verdict_schema_sha256: string | null;
  revision_request_schema_sha256: string | null;
  reviewed_entry_set_sha256: string | null;
}

export interface ManifestEntry { path: string; sha256: string; size_bytes: number; }
export interface ResultBundleManifest {
  schema_version: "1.1";
  kind: "wco-result-bundle";
  run_id: string;
  archive_filename: string;
  published_commit_sha: string;
  base_commit: string;
  change_set_sha256: string;
  pull_request_number: number;
  task_id: string;
  created_at: string;
  spec_set_sha256: string;
  review_contract_sha256: string;
  review_policy_sha256: string;
  verdict_schema_sha256: string;
  revision_request_schema_sha256: string;
  reviewed_entry_set_sha256: string;
  entries: ManifestEntry[];
}

export interface PublicExecutionEvidence {
  run_id: string; task_id: string; state: string; change_set_sha256: string; base_commit: string; branch_name: string;
  implementer: { model: string; reasoning_effort: string; iterations: number };
  internal_reviewer: { model: string; reasoning_effort: string; rounds: number; verdict: string | null; reviewed_change_set_sha256: string | null };
  final_reviewer: { model: string; reasoning_effort: string; rounds: number; verdict: string | null; reviewed_change_set_sha256: string | null };
  verification: { rounds: number; required_commands_passed: boolean; verified_change_set_sha256: string | null };
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  created_at: string; updated_at: string;
}
export interface PublicGitPublishEvidence {
  run_id: string; state: string; base_commit: string; branch_name: string; remote_name: string; change_set_sha256: string;
  expected_paths: string[]; commit_sha: string; remote_branch_sha: string; created_at: string; pushed_at: string | null;
}
export interface PublicDraftPrEvidence {
  run_id: string; state: string; pull_request_number: number; pull_request_url: string; change_set_sha256: string;
  git_publish_receipt_sha256: string; created_at: string; opened_at: string | null;
}
export interface ChangedFileEntry { path: string; mode: string; sha256: string; size_bytes: number; }
export interface DeletedFileEntry { path: string; }
export interface ResultBundleLimits {
  maximum_entries: number; maximum_entry_bytes: number; maximum_source_file_bytes: number; maximum_diff_bytes: number;
  maximum_total_uncompressed_bytes: number; maximum_archive_bytes: number; maximum_public_output_bytes_per_command: number;
  maximum_github_response_bytes: number; github_attestation: "required" | "optional";
}
export const DEFAULT_RESULT_BUNDLE_LIMITS: ResultBundleLimits = {
  maximum_entries: 512,
  maximum_entry_bytes: 8_388_608,
  maximum_source_file_bytes: 4_194_304,
  maximum_diff_bytes: 8_388_608,
  maximum_total_uncompressed_bytes: 67_108_864,
  maximum_archive_bytes: 33_554_432,
  maximum_public_output_bytes_per_command: 65_536,
  maximum_github_response_bytes: 1_048_576,
  github_attestation: "required",
};
