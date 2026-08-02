import type { BundleManifest } from "../bundle/contracts.js";

export type ExecutionErrorCode =
  | "EXECUTION_CONTRACT_REQUIRED"
  | "DELIVERY_CONTRACT_INVALID"
  | "GIT_POLICY_INVALID"
  | "BASE_COMMIT_INVALID"
  | "BRANCH_POLICY_VIOLATION";

export interface ExecutionIssue {
  code: ExecutionErrorCode;
  message: string;
}

export interface ExecutionContract {
  schema_version: "1.2";
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
