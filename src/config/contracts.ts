export type FetchPolicy = "never" | "if-missing" | "always";

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

export interface TrustedConfig {
  config_version: "1.0";
  inbox: InboxConfig;
  repositories: Record<string, RepositoryConfig>;
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
