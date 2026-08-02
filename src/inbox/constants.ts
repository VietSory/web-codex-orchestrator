export const INBOX_CANDIDATE_PATTERN = /^wco-task-[A-Za-z0-9._-]+\.zip$/i;

export const DEFAULT_INBOX_CONFIG = {
  poll_interval_ms: 2000,
  stable_age_ms: 3000,
  stable_observations: 2,
  maximum_candidates_per_scan: 100,
} as const;
