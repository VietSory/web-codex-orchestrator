export interface BundleManifest {
  schema_version: "1.0";
  task_id: string;
  title: string;
  repository: {
    base_branch: string;
    base_commit: string;
  };
  limits: {
    max_internal_iterations: number;
    max_review_rounds: number;
    max_changed_files: number;
    max_diff_lines: number;
  };
  allowed_paths: string[];
  forbidden_paths: string[];
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

export interface ValidationCommand {
  id: string;
  command: string;
  required: boolean;
  timeout_seconds: number;
}

export interface ValidationContract {
  commands: ValidationCommand[];
}

export interface RiskPolicy {
  human_approval_required_for: string[];
}
