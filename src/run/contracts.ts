export const RUN_STATES = [
  "DISCOVERED",
  "INTAKING",
  "INTAKE_REJECTED",
  "ACCEPTED",
  "RESOLVING_REPOSITORY",
  "FETCHING_BASE",
  "VERIFYING_BASE",
  "CREATING_WORKTREE",
  "VERIFYING_WORKTREE",
  "READY_FOR_CODEX",
  "BLOCKED",
  "FAILED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export interface RunReceipt {
  run_version: "1.0";
  run_id: string;
  status: RunState;
  task_id: string;
  archive_sha256: string;
  bundle_schema_version: "1.2";
  repository_id: string;
  repository_path: string;
  remote: string;
  remote_url: string;
  base_branch: string;
  base_commit: string;
  branch_name: string;
  worktree_path: string;
  accepted_bundle_path: string;
  state: RunState;
  checks: string[];
  errors: Array<{ code: string; message: string }>;
  created_at: string;
  updated_at: string;
}

export interface RunEvent {
  event_version: "1.0";
  run_id: string;
  sequence: number;
  from: RunState;
  to: RunState;
  timestamp: string;
  details: Record<string, unknown>;
}

export interface PreparationResult extends RunReceipt {
  status: "READY_FOR_CODEX";
  state: "READY_FOR_CODEX";
}
