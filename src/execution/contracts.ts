import type { BundleManifest } from "../bundle/contracts.js";
import type { ReasoningEffort } from "../config/contracts.js";

export type ExecutionErrorCode =
  | "EXECUTION_CONTRACT_REQUIRED"
  | "EXECUTION_SCHEMA_UPGRADE_REQUIRED"
  | "DELIVERY_CONTRACT_INVALID"
  | "GIT_POLICY_INVALID"
  | "BASE_COMMIT_INVALID"
  | "BRANCH_POLICY_VIOLATION"
  | "EXECUTION_CONFIG_INVALID" | "EXECUTION_STATE_INVALID" | "EXECUTION_LOCKED"
  | "EXECUTION_RECEIPT_INCONSISTENT" | "CODEX_RUNTIME_NOT_FOUND" | "CODEX_RUNTIME_VERSION_MISMATCH" | "CODEX_AUTH_UNAVAILABLE"
  | "CODEX_SANDBOX_UNAVAILABLE" | "CODEX_TURN_TIMEOUT" | "CODEX_TURN_FAILED"
  | "AGENT_OUTPUT_INVALID" | "AGENT_ASSESSMENT_MUTATED_WORKTREE" | "AGENT_COMMITTED_CHANGES"
  | "AGENT_CHANGED_BRANCH" | "BUNDLE_MUTATED" | "PATH_POLICY_VIOLATION"
  | "FORBIDDEN_PATH_CHANGED" | "CHANGE_LIMIT_EXCEEDED" | "SYMLINK_CHANGE_NOT_ALLOWED"
  | "SPECIAL_FILE_CHANGE_NOT_ALLOWED" | "SUBMODULE_CHANGE_NOT_ALLOWED" | "BINARY_CHANGE_NOT_ALLOWED"
  | "VALIDATION_CONTRACT_INVALID" | "VALIDATION_EXECUTABLE_DENIED" | "VALIDATION_ENVIRONMENT_DENIED"
  | "VALIDATION_CWD_UNSAFE" | "VERIFIER_SANDBOX_UNAVAILABLE" | "VERIFIER_TIMEOUT"
  | "VERIFIER_OUTPUT_LIMIT" | "VERIFIER_MUTATED_SOURCE" | "VERIFICATION_FAILED"
  | "TERRA_REVIEW_REQUIRED" | "TERRA_REVIEW_OUTPUT_INVALID" | "TERRA_REVIEW_STALE"
  | "TERRA_REVIEW_MUTATED_WORKTREE" | "SOL_REVIEW_NOT_ALLOWED" | "REVIEW_OUTPUT_INVALID"
  | "REVIEW_STALE" | "REVIEW_MUTATED_WORKTREE" | "REPLAN_REQUIRED" | "HUMAN_REQUIRED"
  | "BUDGET_EXHAUSTED" | "INTERRUPTED" | "OPERATIONAL_ERROR";

export interface ExecutionIssue {
  code: ExecutionErrorCode;
  message: string;
}

export interface ExecutionContract {
  schema_version: "1.2" | "1.3";
  task_id: string;
  title: string;
  repository: {
    id: string;
    base_branch: string;
    base_commit: string;
  };
  delivery: {
    mode: "github_pull_request";
    remote: string;
    base_branch: string;
    branch_name: string;
    draft: true;
    push_after: ["VERIFIER_PASS", "SOL_APPROVE"];
    auto_merge: false;
  };
  git_policy: {
    allowed_remote: string;
    allowed_branch_prefix: string;
    deny_direct_push_branches: string[];
    allow_force_push: false;
    allow_remote_branch_delete: false;
    allow_merge: false;
  };
  limits: BundleManifest["limits"];
  allowed_paths: string[];
  forbidden_paths: string[];
}

export interface ExecutionValidationReport {
  ok: boolean;
  issues: ExecutionIssue[];
  contract?: ExecutionContract;
}

export const EXECUTION_STATES = [
  "READY_FOR_CODEX", "CODEX_PREFLIGHT", "TERRA_ASSESSING", "TERRA_IMPLEMENTING",
  "POLICY_CHECKING", "VERIFYING", "TERRA_FIXING", "TERRA_REVIEWING", "SOL_REVIEWING",
  "READY_FOR_PUBLISH", "REPLAN_REQUIRED", "WEB_REVIEW_REQUIRED", "HUMAN_REQUIRED",
  "POLICY_BLOCKED", "VERIFICATION_FAILED", "AGENT_FAILED", "BUDGET_EXHAUSTED",
  "INTERRUPTED", "FAILED",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export type ReviewVerdict = "APPROVE" | "REVISE" | "REPLAN" | "ESCALATE";
export type AcceptanceStatus = "PASS" | "FAIL" | "UNVERIFIED";

export interface AcceptanceResult {
  acceptance_id: string;
  status: AcceptanceStatus;
  evidence: string[];
}

export type HumanAction = null | { category: "credential" | "network" | "destructive" | "production" | "ambiguous_requirement" | "paid_resource" | "other"; description: string; requested_capability: string };

export interface ReviewFinding {
  id: string;
  severity: "medium" | "high" | "critical";
  category: "correctness" | "security" | "regression" | "scope" | "tests" | "maintainability" | "performance";
  file: string;
  line_start: number;
  line_end: number;
  acceptance_ids: string[];
  problem: string;
  evidence: string;
  required_fix: string;
}

export interface AgentAssessment {
  status: "COMPATIBLE" | "REPLAN_REQUIRED" | "HUMAN_REQUIRED" | "BLOCKED";
  summary: string;
  repository_observations: string[];
  bundle_conflicts: Array<{ id: string; severity: "low" | "medium" | "high" | "critical"; description: string; affected_contract: string }>;
  missing_prerequisites: string[];
  human_action: HumanAction;
}

export interface AgentImplementationResult {
  status: "READY_FOR_VERIFICATION" | "REPLAN_REQUIRED" | "HUMAN_REQUIRED" | "BLOCKED";
  summary: string;
  changed_files_claimed: string[];
  acceptance_evidence: Array<{ acceptance_id: string; status: "implemented" | "partially_implemented" | "blocked"; evidence: string[]; notes: string }>;
  tests_added_or_changed: string[];
  unresolved_issues: string[];
  human_action: HumanAction;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  reviewed_change_set_sha256: string;
  summary: string;
  acceptance_results: AcceptanceResult[];
  blocking_findings: ReviewFinding[];
  non_blocking_findings: ReviewFinding[];
  scope_violations: string[];
  unverified_acceptance: string[];
  recommended_next_state?: ExecutionState;
  human_action: HumanAction;
}

export interface VerificationCommandResult {
  result_version: "1.0";
  command_id: string;
  required: boolean;
  specification_sha256: string;
  executable: string;
  args: string[];
  cwd: string;
  environment_keys: string[];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdout?: string;
  stderr?: string;
  stdout_log_path?: string;
  stderr_log_path?: string;
  generated_paths: string[];
  status: "PASS" | "FAIL" | "TIMEOUT" | "DENIED" | "MUTATED";
}

export interface VerificationFailureEvidence {
  verification_round: number;
  failed_command_ids: string[];
  commands: Array<{
    command_id: string;
    status: "FAIL" | "TIMEOUT";
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    stdout_tail: string;
    stderr_tail: string;
  }>;
  remaining_implementation_iterations: number;
}

export interface ChangeEntry {
  path: string;
  change_type: "added" | "modified" | "deleted" | "renamed";
  mode: string;
  content_sha256: string | null;
  old_path?: string;
  binary?: boolean;
  special?: boolean;
}

export interface ChangeSet {
  change_set_sha256: string;
  base_commit: string;
  branch_name: string;
  entries: ChangeEntry[];
  diff_lines: number;
  tracked_paths: string[];
  untracked_paths: string[];
  generated_paths: string[];
  tracked_diff_sha256?: string;
  refs_sha256?: string;
}

export interface ExecutionReceipt {
  execution_version: "1.0";
  run_id: string;
  state: ExecutionState;
  base_commit: string;
  branch_name: string;
  worktree_path: string;
  accepted_bundle_path: string;
  repository_refs_sha256?: string | null;
  implementer: { model: string; reasoning_effort: ReasoningEffort; thread_id: string; iterations: number };
  internal_reviewer: { model: string; reasoning_effort: ReasoningEffort; rounds: number; latest_thread_id: string | null; thread_ids?: string[]; verdict: ReviewVerdict | null; reviewed_change_set_sha256: string | null };
  final_reviewer: { model: string; reasoning_effort: ReasoningEffort; rounds: number; latest_thread_id: string | null; thread_ids?: string[]; verdict: ReviewVerdict | null; reviewed_change_set_sha256: string | null };
  verification: { rounds: number; required_commands_passed: boolean; verified_change_set_sha256: string | null; commands: VerificationCommandResult[] };
  pending_verification_failure?: VerificationFailureEvidence | null;
  change_set_sha256: string | null;
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number; total_turns?: number; started_at?: string };
  errors: Array<{ code: string; message: string }>;
  created_at: string;
  updated_at: string;
}
