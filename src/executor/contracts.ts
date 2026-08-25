import type { ReasoningEffort } from "../config/contracts.js";
import type { ReviewerRepairOperation } from "../execution/contracts.js";

export type ExecutorState =
  | "VALIDATING" | "PREPARED" | "APPLYING" | "APPLIED" | "VERIFYING" | "REVIEWING_WEB" | "REVIEWING_TERRA" | "REVIEWING_SOL" | "REPAIR_APPLYING" | "REPAIR_APPLIED" | "READY_FOR_PUBLISH" | "ESCALATE_TO_WEB" | "FAILED";
export type ExecutorOperationKind = "create_file" | "replace_file" | "delete_file";
export type ExecutorReviewStrategy = "web" | "model";
export type ExecutorRepairAuthority = "web" | "terra" | "sol";

export interface ExecutorTransactionOperation { op_id: string; kind: ExecutorOperationKind; path: string; preimage_sha256: string | null; postimage_sha256: string | null; backup_relative_path: string | null; backup_sha256: string | null; original_mode: number | null; applied: boolean; }
export interface ExecutorDiagnostic { code: string; message: string; at: string; }
export interface ExecutorReviewReceipt { rounds: number; verdict: "APPROVE" | "REVISE" | "ESCALATE" | null; change_set_digest: string | null; evidence_sha256: string | null; }
export interface ExecutorRepairPreimageBackup { path: string; sha256: string; relative_path: string; mode: number; }
export interface ExecutorRepairReceipt {
  reviewer: ExecutorRepairAuthority;
  source_change_set_digest: string;
  source_review_evidence_sha256: string;
  operations: ReviewerRepairOperation[];
  /** Only paths whose source bytes differ from the registered Web postimage need a backup. */
  preimage_backups?: ExecutorRepairPreimageBackup[];
  state: "PROPOSED" | "APPLYING" | "APPLIED" | "VERIFIED";
  final_change_set_digest: string | null;
}
export interface ExecutorRepairHistoryEntry { generation: number; reviewer: ExecutorRepairAuthority; source_change_set_digest: string; source_review_evidence_sha256: string; operations_sha256: string; operation_count: number; final_change_set_digest: string; verified_at: string; }
export interface ExecutorUsage { model_turns: number; input_tokens: number; output_tokens: number; }
export interface ExecutorVerificationCommandEvidence {
  command_id: string;
  required: boolean;
  status: "PASS" | "FAIL" | "TIMEOUT" | "DENIED" | "MUTATED";
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdout_tail: string;
  stderr_tail: string;
}

export interface ExecutorReceipt {
  executor_version: "1.0";
  run_id: string;
  task_id: string;
  task_bundle_sha256: string;
  artifact_sha256: string;
  pack_id: string;
  state: ExecutorState;
  repository_id: string;
  base_branch: string;
  base_commit: string;
  base_tree_sha: string;
  worktree_path: string;
  registration_manifest_sha256: string;
  operations: ExecutorTransactionOperation[];
  change_set_digest: string | null;
  review_strategy?: ExecutorReviewStrategy;
  reviewer_selection?: { kind: "terra" | "sol"; model: string; reasoning_effort: ReasoningEffort; };
  repair?: ExecutorRepairReceipt;
  repair_history?: ExecutorRepairHistoryEntry[];
  /**
   * Browser PAIR keeps the original REVISE evidence immutable in the selected
   * reviewer receipt. If that reviewer-authored repair is applied, this
   * separate receipt records the fresh review of the exact repaired digest.
   */
  repair_reapproval?: ExecutorReviewReceipt;
  verification: { rounds: number; passed: boolean; change_set_digest: string | null; evidence_sha256: string | null; };
  terra_review: ExecutorReviewReceipt;
  sol_review: ExecutorReviewReceipt;
  usage?: ExecutorUsage;
  errors: ExecutorDiagnostic[];
  created_at: string;
  updated_at: string;
}

export type ExecutorErrorCode = "EXECUTOR_INVALID_RUN_ID" | "EXECUTOR_REGISTRATION_NOT_FOUND" | "EXECUTOR_REGISTRATION_INVALID" | "EXECUTOR_CANONICAL_AUTHORITY_DRIFT" | "EXECUTOR_WORKTREE_UNSAFE" | "EXECUTOR_PREIMAGE_STALE" | "EXECUTOR_TRANSACTION_INVALID" | "EXECUTOR_REPAIR_INVALID" | "EXECUTOR_AMBIGUOUS_RECOVERY" | "EXECUTOR_POSTIMAGE_MISMATCH" | "EXECUTOR_UNREGISTERED_CHANGE" | "EXECUTOR_VERIFICATION_FAILED" | "EXECUTOR_REVIEW_REJECTED" | "EXECUTOR_BUDGET_EXHAUSTED" | "EXECUTOR_LOCKED" | "EXECUTOR_STATE_INVALID" | "EXECUTOR_OPERATIONAL_ERROR";
export class ExecutorError extends Error { constructor(public readonly code: ExecutorErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "ExecutorError"; } }