import path from "node:path";
import type { ConfigIssue, ConfigValidationReport, TrustedConfig } from "./contracts.js";
import { hasSensitiveHttpUserInfo } from "./remote-url.js";

const TOP_LEVEL = new Set(["config_version", "inbox", "repositories", "agents", "verification"]);
const INBOX_FIELDS = new Set(["poll_interval_ms", "stable_age_ms", "stable_observations", "maximum_candidates_per_scan"]);
const REPOSITORY_FIELDS = new Set(["path", "remote", "expected_remote_urls", "fetch_policy"]);
const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_FIELDS = new Set(["implementer", "internal_reviewer", "final_reviewer", "limits"]);
const AGENT_PROFILE_FIELDS = new Set(["model", "reasoning_effort"]);
const AGENT_LIMIT_FIELDS = new Set(["maximum_implementation_iterations", "maximum_internal_review_rounds", "maximum_sol_review_rounds", "maximum_total_agent_turns", "maximum_turn_seconds", "maximum_total_seconds", "maximum_total_input_tokens", "maximum_total_output_tokens"]);
const VERIFICATION_FIELDS = new Set(["allowed_executables", "allowed_environment_keys", "maximum_command_seconds", "maximum_output_bytes", "maximum_file_bytes", "maximum_changed_files", "maximum_diff_lines", "allowed_generated_paths"]);

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
  const agents = value.agents;
  if (agents !== undefined) {
    if (!isRecord(agents)) add(issues, "agents must be an object.");
    else {
      for (const key of unknownFields(agents, AGENT_FIELDS)) add(issues, `Unknown agents field: ${key}`);
      for (const key of ["implementer", "internal_reviewer", "final_reviewer"] as const) {
        const profile = agents[key];
        if (!isRecord(profile)) { add(issues, `agents.${key} must be an object.`); continue; }
        for (const field of unknownFields(profile, AGENT_PROFILE_FIELDS)) add(issues, `Unknown agents.${key} field: ${field}`);
        if (typeof profile.model !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(profile.model)) add(issues, `agents.${key}.model is invalid.`);
        if (profile.reasoning_effort !== "low" && profile.reasoning_effort !== "medium" && profile.reasoning_effort !== "high" && profile.reasoning_effort !== "xhigh") add(issues, `agents.${key}.reasoning_effort is invalid.`);
      }
      const limits = agents.limits;
      if (!isRecord(limits)) add(issues, "agents.limits must be an object.");
      else {
        for (const field of unknownFields(limits, AGENT_LIMIT_FIELDS)) add(issues, `Unknown agents.limits field: ${field}`);
        for (const field of AGENT_LIMIT_FIELDS) if (!positiveInteger(limits[field])) add(issues, `agents.limits.${field} must be a positive integer.`);
      }
    }
  }
  const verification = value.verification;
  if (verification !== undefined) {
    if (!isRecord(verification)) add(issues, "verification must be an object.");
    else {
      for (const key of unknownFields(verification, VERIFICATION_FIELDS)) add(issues, `Unknown verification field: ${key}`);
      for (const field of ["allowed_executables", "allowed_environment_keys", "allowed_generated_paths"] as const) {
        if (!Array.isArray(verification[field]) || field === "allowed_executables" && verification[field].length === 0 || !verification[field].every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 128 && !entry.includes("\u0000"))) add(issues, `verification.${field} must be a string array.`);
      }
      if (Array.isArray(verification.allowed_executables) && verification.allowed_executables.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9._+-]+$/.test(entry) || entry.includes("/") || entry.includes("\\") || /\s/.test(entry))) add(issues, "verification.allowed_executables contains an unsafe executable.");
      if (Array.isArray(verification.allowed_executables) && verification.allowed_executables.some((entry) => typeof entry === "string" && /^(?:sh|bash|dash|zsh|cmd|powershell|pwsh|curl|wget|gh|ssh|scp|nc|telnet|docker|podman|kubectl|helm|terraform|tofu)$/i.test(entry))) add(issues, "verification.allowed_executables contains a shell or network-capable executable.");
      if (Array.isArray(verification.allowed_environment_keys) && verification.allowed_environment_keys.some((entry) => typeof entry !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(entry) || /^(?:PATH|HOME|USERPROFILE|SYSTEMROOT|SHELL|COMSPEC|CODEX_HOME|BASH_ENV|ENV|CDPATH|IFS|NODE_OPTIONS|PYTHONPATH|LD_PRELOAD|GIT_DIR|GIT_WORK_TREE)$/i.test(entry) || /^GIT_CONFIG|^SSH_|^AWS_|^AZURE_|^GOOGLE_|^GITHUB_|^OPENAI_|^NPM_CONFIG_|^COREPACK_|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|PROXY/i.test(entry))) add(issues, "verification.allowed_environment_keys contains a reserved or unsafe key.");
      if (Array.isArray(verification.allowed_generated_paths) && verification.allowed_generated_paths.some((entry) => typeof entry !== "string" || path.isAbsolute(entry) || entry.replaceAll("\\", "/").split("/").includes("..") || entry.replaceAll("\\", "/") === ".git" || entry.replaceAll("\\", "/").startsWith(".git/"))) add(issues, "verification.allowed_generated_paths contains an unsafe path.");
      if (!positiveInteger(verification.maximum_command_seconds) || verification.maximum_command_seconds > 86400) add(issues, "verification.maximum_command_seconds is invalid.");
      if (!positiveInteger(verification.maximum_output_bytes) || verification.maximum_output_bytes > 100_000_000) add(issues, "verification.maximum_output_bytes is invalid.");
      if (verification.maximum_file_bytes !== undefined && (!positiveInteger(verification.maximum_file_bytes) || verification.maximum_file_bytes > 1_000_000_000)) add(issues, "verification.maximum_file_bytes is invalid.");
      if (verification.maximum_changed_files !== undefined && (!positiveInteger(verification.maximum_changed_files) || verification.maximum_changed_files > 100_000)) add(issues, "verification.maximum_changed_files is invalid.");
      if (verification.maximum_diff_lines !== undefined && (!positiveInteger(verification.maximum_diff_lines) || verification.maximum_diff_lines > 10_000_000)) add(issues, "verification.maximum_diff_lines is invalid.");
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    issues: [],
    config: value as unknown as TrustedConfig,
  };
}
