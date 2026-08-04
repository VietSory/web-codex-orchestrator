export type FetchPolicy = "never" | "if-missing" | "always";
import type { TrustedCodexRuntimeConfig } from "../runtime/codex-runtime.js";

export interface InboxConfig {
  poll_interval_ms: number;
  stable_age_ms: number;
  stable_observations: number;
  maximum_candidates_per_scan: number;
}

export interface RepositoryConfig {
  path: string;
  remote: string;
  expected_remote_urls: string[];
  fetch_policy: FetchPolicy;
}

export interface PublishIdentityConfig {
  name: string;
  email: string;
}

export type PublishAuthenticationConfig =
  | {
      mode: "none";
    }
  | {
      mode: "https_token";
      token_environment_key: string;
    }
  | {
      mode: "ssh_agent";
      socket_environment_key: "SSH_AUTH_SOCK";
    };

export interface PublishConfig {
  identity: PublishIdentityConfig;
  authentication: PublishAuthenticationConfig;
}

export interface TrustedConfig {
  config_version: "1.0";
  inbox: InboxConfig;
  repositories: Record<string, RepositoryConfig>;
  runtime?: TrustedCodexRuntimeConfig;
  agents?: AgentConfig;
  verification?: VerificationConfig;
  publish?: PublishConfig;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentProfile {
  model: string;
  reasoning_effort: ReasoningEffort;
}

export interface AgentLimits {
  maximum_implementation_iterations: number;
  maximum_internal_review_rounds: number;
  maximum_sol_review_rounds: number;
  maximum_total_agent_turns: number;
  maximum_turn_seconds: number;
  maximum_total_seconds: number;
  maximum_total_input_tokens: number;
  maximum_total_output_tokens: number;
}

export interface AgentConfig {
  implementer: AgentProfile;
  internal_reviewer: AgentProfile;
  final_reviewer: AgentProfile;
  limits: AgentLimits;
}

export interface VerificationConfig {
  allowed_executables: string[];
  allowed_environment_keys: string[];
  maximum_command_seconds: number;
  maximum_output_bytes: number;
  maximum_file_bytes?: number;
  maximum_changed_files?: number;
  maximum_diff_lines?: number;
  allowed_generated_paths: string[];
}

export type ConfigErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_NOT_REGULAR_FILE"
  | "CONFIG_SYMLINK"
  | "CONFIG_INVALID"
  | "REPOSITORY_PATH_UNSAFE"
  | "REPOSITORY_NOT_REGISTERED";

export interface ConfigIssue {
  code: ConfigErrorCode;
  message: string;
}

export interface ConfigValidationReport {
  ok: boolean;
  issues: ConfigIssue[];
  config?: TrustedConfig;
}
