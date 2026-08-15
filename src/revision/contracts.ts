import type { ReasoningEffort } from "../config/contracts.js";
import type { VerificationCommandResult, ReviewVerdict } from "../execution/contracts.js";
import type { ExecutorVerificationCommandEvidence } from "../executor/contracts.js";

export const REVISION_STATES = [
  "READY_TO_REVISE","IMPLEMENTING","POLICY_CHECKING","VERIFYING","TERRA_REVIEWING","SOL_REVIEWING",
  "READY_FOR_PUBLISH","COMMITTED","PUSHED","RESULT_READY","BLOCKED","RETRYABLE","FAILED",
] as const;
export type RevisionState = (typeof REVISION_STATES)[number];
export type RevisionResumeState = Exclude<RevisionState, "RESULT_READY" | "BLOCKED" | "RETRYABLE" | "FAILED">;

export type RevisionErrorCode =
  | "REVISION_REQUEST_INVALID" | "REVISION_HISTORY_INVALID" | "REVISION_STATE_INVALID" | "REVISION_STATE_UNSAFE"
  | "REVISION_LOCKED" | "REVISION_CONFIG_INVALID" | "REVISION_BUNDLE_MUTATED" | "REVISION_SPEC_DRIFT"
  | "REVISION_WORKTREE_UNSAFE" | "REVISION_WORKTREE_DIRTY" | "REVISION_HEAD_DRIFT" | "REVISION_BRANCH_DRIFT"
  | "REVISION_PR_DRIFT" | "REVISION_REMOTE_DRIFT" | "REVISION_AGENT_FAILED" | "REVISION_POLICY_BLOCKED"
  | "REVISION_VERIFICATION_FAILED" | "REVISION_TERRA_REVIEW_FAILED" | "REVISION_SOL_REVIEW_FAILED"
  | "REVISION_BUDGET_EXHAUSTED" | "REVISION_AMBIGUOUS_RECOVERY" | "REVISION_COMMIT_FAILED" | "REVISION_PUSH_FAILED" | "REVISION_RESULT_FAILED"
  | "REVISION_INTERRUPTED" | "REVISION_OPERATIONAL_ERROR";

export class RevisionError extends Error {
  readonly code: RevisionErrorCode;
  readonly details?: Record<string, unknown> | undefined;
  constructor(code: RevisionErrorCode, message: string, details?: Record<string, unknown>) { super(message); this.name = "RevisionError"; this.code = code; this.details = details; }
}
export function isRevisionError(error: unknown): error is RevisionError { return error instanceof RevisionError; }
export function revisionExitCode(code: RevisionErrorCode): number {
  if (["REVISION_REQUEST_INVALID","REVISION_HISTORY_INVALID","REVISION_STATE_INVALID","REVISION_STATE_UNSAFE","REVISION_CONFIG_INVALID","REVISION_BUNDLE_MUTATED","REVISION_SPEC_DRIFT","REVISION_WORKTREE_UNSAFE","REVISION_WORKTREE_DIRTY","REVISION_HEAD_DRIFT","REVISION_BRANCH_DRIFT","REVISION_PR_DRIFT","REVISION_REMOTE_DRIFT","REVISION_POLICY_BLOCKED","REVISION_VERIFICATION_FAILED","REVISION_TERRA_REVIEW_FAILED","REVISION_SOL_REVIEW_FAILED","REVISION_BUDGET_EXHAUSTED","REVISION_AMBIGUOUS_RECOVERY"].includes(code)) return 1;
  return 3;
}

export type RevisionFindingClassification = "SPEC_VIOLATION" | "IMPLEMENTATION_DEFECT" | "EVIDENCE_GAP" | "REPOSITORY_DRIFT";
export interface RevisionFinding {
  finding_id: string;
  classification: RevisionFindingClassification;
  finding_origin: "INITIAL_DISCOVERY" | "PREVIOUS_UNRESOLVED" | "REVISION_REGRESSION" | "REVISION_EVIDENCE_INVALIDATION";
  locked_reference_ids: string[];
  artifact_paths: string[];
  line_or_json_pointer: string;
  evidence: string;
  minimal_required_fix: string;
}
export interface RevisionRequest {
  schema_version: "1.1";
  run_id: string;
  revision_round: number;
  spec_set_sha256: string;
  previous_result_bundle_sha256: string;
  previous_verdict_sha256: string;
  previous_published_commit_sha: string;
  previous_pr_head_sha: string;
  pull_request_number: number;
  findings: RevisionFinding[];
}
export interface RevisionReviewEvidence {
  model: string;
  reasoning_effort: ReasoningEffort;
  rounds: number;
  thread_ids: string[];
  verdict: ReviewVerdict | null;
  reviewed_change_set_sha256: string | null;
}
export interface RevisionUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_turns: number;
  implementation_iterations: number;
  internal_review_rounds: number;
  sol_review_rounds: number;
  started_at: string;
}
export interface RevisionReceipt {
  phase_version: "1.0";
  run_id: string;
  revision_round: number;
  state: RevisionState;
  resume_state: RevisionResumeState | null;
  spec_set_sha256: string;
  revision_request_sha256: string;
  previous_result_bundle_sha256: string;
  previous_result_receipt_sha256: string;
  previous_verdict_sha256: string;
  previous_published_commit_sha: string;
  previous_pr_head_sha: string;
  pull_request_number: number;
  branch_name: string;
  base_branch: string;
  worktree_path: string;
  initial_refs_sha256: string;
  implementer: { model: string; reasoning_effort: ReasoningEffort; thread_id: string | null; iterations: number };
  verification: { rounds: number; required_commands_passed: boolean; verified_change_set_sha256: string | null; commands: Array<VerificationCommandResult | ExecutorVerificationCommandEvidence> };
  terra_review: RevisionReviewEvidence;
  sol_review: RevisionReviewEvidence;
  usage: RevisionUsage;
  revision_change_set_sha256: string | null;
  revision_paths: string[];
  approved_snapshot_sha256: string | null;
  new_published_commit_sha: string | null;
  remote_branch_sha: string | null;
  result_bundle_sha256: string | null;
  result_manifest_sha256: string | null;
  next_review_round: number;
  errors: Array<{ code: string; message: string }>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
