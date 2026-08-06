// Core interfaces, types, and error classes for Phase 7 Web Review Verdict Processing

export type WebReviewState =
  | "READY_TO_VALIDATE"
  | "VALIDATING"
  | "VALIDATED"
  | "APPROVED"
  | "REVISION_REQUESTED"
  | "ESCALATED"
  | "BLOCKED"
  | "RETRYABLE"
  | "FAILED";

export type DecisionAction =
  | "ASK_USER_TO_MERGE"
  | "NO_USER_MERGE_PROMPT"
  | "NOTIFY_USER_EXCEPTION";

export type DecisionState = "APPROVED" | "REVISION_REQUESTED" | "ESCALATED";

/** Phase 7 per-round receipt structure */
export interface WebReviewReceipt {
  phase_version: "1.1";
  run_id: string;
  review_mode: "INITIAL" | "REVISION";
  review_round: number;
  state: WebReviewState;
  phase6_receipt_sha256: string;
  result_bundle_sha256: string;
  manifest_sha256: string;
  reviewed_entry_set_sha256: string;
  spec_set_sha256: string;
  verdict_sha256: string | null;
  published_commit_sha: string;
  pull_request_number: number;
  observed_head_sha: string;
  fresh_attested_head_sha: string | null;
  fresh_attested_base_branch: string | null;
  previous_result_bundle_sha256: string | null;
  previous_verdict_sha256: string | null;
  previous_published_commit_sha: string | null;
  previous_pr_head_sha: string | null;
  revision_request_sha256: string | null;
  decision_event_sha256: string | null;
  action: DecisionAction | null;
  artifact_paths: {
    verdict: string | null;
    receipt: string;
    decision_event: string | null;
    revision_request: string | null;
    lock: string;
  };
  warnings: string[];
  errors: Array<{ code: string; message: string }>;
  created_at: string;
  updated_at: string;
  validated_at: string | null;
  completed_at: string | null;
}

/** Canonical decision event structure */
export interface DecisionEvent {
  schema_version: "1.1";
  kind: "wco-decision-event";
  run_id: string;
  review_mode: "INITIAL" | "REVISION";
  review_round: number;
  state: DecisionState;
  action: DecisionAction;
  verdict_sha256: string;
  revision_request_sha256: string | null;
  result_bundle_sha256: string;
  published_commit_sha: string;
  pull_request_number: number;
  observed_head_sha: string;
  created_at: string;
}

/** Revision finding per revision-request.schema.json 1.1 */
export interface RevisionFinding {
  finding_id: string;
  classification:
    | "SPEC_VIOLATION"
    | "IMPLEMENTATION_DEFECT"
    | "EVIDENCE_GAP"
    | "REPOSITORY_DRIFT";
  finding_origin:
    | "INITIAL_DISCOVERY"
    | "PREVIOUS_UNRESOLVED"
    | "REVISION_REGRESSION"
    | "REVISION_EVIDENCE_INVALIDATION";
  locked_reference_ids: string[];
  artifact_paths: string[];
  line_or_json_pointer: string;
  evidence: string;
  minimal_required_fix: string;
}

import type { WebReviewVerdict, VerdictBlockingFinding } from "../result-bundle/web-verdict-validator.js";
export type { WebReviewVerdict, VerdictBlockingFinding };

/** Canonical revision request structure per revision-request.schema.json 1.1 */
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

export class WebReviewError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode?: number) {
    super(message);
    this.name = "WebReviewError";
    this.code = code;
    this.exitCode = exitCode ?? webReviewExitCode(code);
  }
}

export function isWebReviewError(err: unknown): err is WebReviewError {
  return err instanceof Error && err.name === "WebReviewError" && typeof (err as any).code === "string";
}

/** Map error code to stable CLI exit code (0, 1, 2, 3) */
export function webReviewExitCode(code: string): number {
  switch (code) {
    case "WEB_REVIEW_CLI_USAGE":
      return 2;

    case "WEB_REVIEW_OPERATIONAL_ERROR":
    case "WEB_REVIEW_LOCK_FAILED":
    case "WEB_REVIEW_NETWORK_ERROR":
    case "WEB_REVIEW_AUTH_ERROR":
    case "WEB_REVIEW_ATTEMPTED_PATH_ESCAPE":
      return 3;

    // All contract, policy, binding, stale artifact, or blocked validation errors:
    default:
      return 1;
  }
}
