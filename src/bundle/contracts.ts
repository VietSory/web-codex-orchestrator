export interface BundleManifest {
  schema_version: "1.0" | "1.1" | "1.2" | "1.3";
  task_id: string;
  title: string;
  repository: {
    id?: string;
    base_branch: string;
    base_commit: string;
  };
  delivery?: BundleDelivery;
  git_policy?: BundleGitPolicy;
  limits: {
    max_internal_iterations: number;
    max_review_rounds: number;
    max_changed_files: number;
    max_diff_lines: number;
  };
  allowed_paths: string[];
  forbidden_paths: string[];
  payload?: BundlePayload;
}

export interface BundleDelivery {
  mode: "github_pull_request";
  remote: string;
  base_branch: string;
  branch_name: string;
  draft: boolean;
  push_after: string[];
  auto_merge: boolean;
}

export interface BundleGitPolicy {
  allowed_remote: string;
  allowed_branch_prefix: string;
  deny_direct_push_branches: string[];
  allow_force_push: boolean;
  allow_remote_branch_delete: boolean;
  allow_merge: boolean;
}

export interface BundlePayload {
  type: "none" | "apply-script" | "patch" | "files";
  entrypoint?: string;
  review_before_execution: true;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  required: boolean;
  verification: {
    type: "automated-test" | "command" | "manual-review";
    reference?: string;
  };
}

export interface AcceptanceContract {
  criteria: AcceptanceCriterion[];
}

export interface TestCase {
  id: string;
  category: string;
  given: string[];
  when: string;
  then: string[];
}

export interface TestMatrix {
  cases: TestCase[];
}

export interface LegacyValidationCommand {
  id: string;
  command: string;
  required: boolean;
  timeout_seconds: number;
}

export interface StructuredValidationCommand {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  required: boolean;
  timeout_seconds: number;
  maximum_output_bytes: number;
}

export type ValidationCommand = LegacyValidationCommand | StructuredValidationCommand;

export interface ValidationContract {
  commands: ValidationCommand[];
}

export interface RiskPolicy {
  human_approval_required_for: string[];
}
