import path from "node:path";
import type { ConfigIssue, ConfigValidationReport, TrustedConfig } from "./contracts.js";
import { hasSensitiveHttpUserInfo } from "./remote-url.js";

const TOP_LEVEL = new Set(["config_version", "inbox", "repositories"]);
const INBOX_FIELDS = new Set(["poll_interval_ms", "stable_age_ms", "stable_observations", "maximum_candidates_per_scan"]);
const REPOSITORY_FIELDS = new Set(["path", "remote", "expected_remote_urls", "fetch_policy"]);
const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function add(issues: ConfigIssue[], message: string, code: ConfigIssue["code"] = "CONFIG_INVALID"): void {
  issues.push({ code, message });
}

function unknownFields(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function validateConfig(value: unknown): ConfigValidationReport {
  const issues: ConfigIssue[] = [];
  if (!isRecord(value)) {
    add(issues, "Configuration must be a JSON object.");
    return { ok: false, issues };
  }
  for (const key of unknownFields(value, TOP_LEVEL)) add(issues, `Unknown top-level configuration field: ${key}`);
  if (value.config_version !== "1.0") add(issues, 'config_version must equal "1.0".');
  const inbox = value.inbox;
  if (!isRecord(inbox)) {
    add(issues, "inbox must be an object.");
  } else {
    for (const key of unknownFields(inbox, INBOX_FIELDS)) add(issues, `Unknown inbox configuration field: ${key}`);
    for (const key of ["poll_interval_ms", "stable_age_ms", "stable_observations", "maximum_candidates_per_scan"] as const) {
      if (!positiveInteger(inbox[key])) add(issues, `inbox.${key} must be a positive integer.`);
    }
  }
  const repositories = value.repositories;
  if (!isRecord(repositories) || Object.keys(repositories).length === 0) {
    add(issues, "repositories must be a non-empty object.");
  } else {
    for (const [id, raw] of Object.entries(repositories)) {
      if (!REPOSITORY_ID_PATTERN.test(id)) add(issues, `Repository ID is invalid: ${id}`);
      if (!isRecord(raw)) {
        add(issues, `Repository ${id} must be an object.`);
        continue;
      }
      for (const key of unknownFields(raw, REPOSITORY_FIELDS)) add(issues, `Unknown repository field for ${id}: ${key}`);
      if (typeof raw.path !== "string" || !path.isAbsolute(raw.path)) add(issues, `Repository ${id}.path must be absolute.`);
      if (typeof raw.remote !== "string" || !REMOTE_NAME_PATTERN.test(raw.remote)) add(issues, `Repository ${id}.remote must be a safe Git remote name.`);
      if (!Array.isArray(raw.expected_remote_urls) || raw.expected_remote_urls.length === 0 || !raw.expected_remote_urls.every((url) => typeof url === "string" && url.length > 0)) {
        add(issues, `Repository ${id}.expected_remote_urls must be a non-empty string array.`);
      } else if (raw.expected_remote_urls.some((url) => typeof url === "string" && hasSensitiveHttpUserInfo(url))) {
        add(issues, `Repository ${id}.expected_remote_urls must not contain HTTP(S) userinfo or credentials.`);
      }
      if (raw.fetch_policy !== "never" && raw.fetch_policy !== "if-missing" && raw.fetch_policy !== "always") add(issues, `Repository ${id}.fetch_policy is invalid.`);
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    issues: [],
    config: value as unknown as TrustedConfig,
  };
}
