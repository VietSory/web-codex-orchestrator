import type { InboxConfig } from "../config/contracts.js";

export interface StabilityObservation {
  canonical_path: string;
  size: number;
  mtime_ms: number;
  observed_at_ms: number;
  observations: number;
}

export interface InboxIndexEntry {
  canonical_source_path: string;
  size: number;
  mtime_ms: number;
  archive_sha256?: string;
  latest_run_id?: string;
  latest_result: "ready_for_codex" | "rejected" | "blocked" | "failed";
  last_processed_time: string;
}

export interface InboxIndex {
  index_version: "1.0";
  entries: Record<string, InboxIndexEntry>;
}

export interface ScanCandidateResult {
  path: string;
  result: "ready_for_codex" | "rejected" | "blocked" | "failed" | "unstable" | "skipped";
  run_id?: string;
  archive_sha256?: string;
  error?: { code: string; message: string };
}

export interface ScanSummary {
  scan_version: "1.0";
  discovered: number;
  unstable: number;
  skipped: number;
  ready_for_codex: number;
  rejected: number;
  blocked: number;
  failed: number;
  results: ScanCandidateResult[];
}

export interface ScannerOptions {
  inboxDirectory: string;
  stateDirectory: string;
  configPath: string;
  config?: InboxConfig;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  stability?: Map<string, StabilityObservation>;
}

export interface WatchOptions extends ScannerOptions {
  signal?: AbortSignal;
  maxIterations?: number;
  onScan?: (summary: ScanSummary) => void | Promise<void>;
}
