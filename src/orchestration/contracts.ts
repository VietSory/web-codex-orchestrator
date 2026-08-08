export type OrchestrationStatus = "ACTIVE" | "PAUSED" | "WAITING" | "BLOCKED" | "COMPLETE" | "FAILED";
export type TransitionKind =
  | "REGISTER_WEB_PACK"
  | "EXECUTE_REGISTERED_PACK"
  | "PUBLISH"
  | "OPEN_DRAFT_PR"
  | "PACKAGE_RESULT"
  | "WAIT_WEB_VERDICT"
  | "REVISE"
  | "WAIT_HUMAN"
  | "DONE";
export type AttemptStatus = "STARTED" | "SUCCEEDED" | "RETRYABLE_FAILURE" | "TERMINAL_FAILURE";
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface OrchestrationBudget {
  max_attempts_per_transition: number;
  max_total_attempts: number;
  max_elapsed_ms: number;
  max_model_turns: number;
  max_input_tokens: number;
  max_output_tokens: number;
  total_attempts: number;
  model_turns: number;
  input_tokens: number;
  output_tokens: number;
  started_at: string;
}

export type TransitionAttemptCounters = Record<TransitionKind, number>;

export interface RetryPolicySnapshot {
  consecutive_failures: number;
  next_retry_at: string | null;
  circuit_state: CircuitState;
  circuit_opened_at: string | null;
  last_failure_code: string | null;
}

export interface TransitionAttempt {
  transition: TransitionKind;
  attempt_id: string;
  request_sha256: string;
  status: AttemptStatus;
  attempt_number: number;
  started_at: string;
  finished_at: string | null;
  result_sha256: string | null;
  failure_code: string | null;
}

export interface OrchestrationEvent {
  sequence: number;
  kind: string;
  at: string;
  data_sha256: string;
  previous_hash: string;
  event_hash: string;
}

export interface DiagnosticCounter {
  code: string;
  message: string;
  count: number;
  first_at: string;
  last_at: string;
}

export interface RunLedger {
  ledger_version: "1.0";
  run_id: string;
  task_id: string;
  task_bundle_sha256: string;
  status: OrchestrationStatus;
  paused: boolean;
  pause_reason: string | null;
  next_transition: TransitionKind;
  current_attempt: TransitionAttempt | null;
  last_completed_transition: TransitionKind | null;
  transition_attempts: TransitionAttemptCounters;
  budget: OrchestrationBudget;
  retry: RetryPolicySnapshot;
  diagnostics: DiagnosticCounter[];
  history_anchor_hash: string;
  compacted_event_count: number;
  events: OrchestrationEvent[];
  created_at: string;
  updated_at: string;
}

export class OrchestrationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OrchestrationError";
  }
}
