import path from "node:path";
import type { ConfigIssue, ConfigValidationReport, TrustedConfig } from "./contracts.js";
import { hasSensitiveHttpUserInfo } from "./remote-url.js";

const TOP_LEVEL = new Set(["config_version", "inbox", "repositories", "runtime", "agents", "verification", "publish", "github_pull_request", "result_bundle", "ui", "web_bridge"]);
const INBOX_FIELDS = new Set(["poll_interval_ms", "stable_age_ms", "stable_observations", "maximum_candidates_per_scan"]);
const REPOSITORY_FIELDS = new Set(["path", "remote", "expected_remote_urls", "fetch_policy"]);
const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_FIELDS = new Set(["implementer", "internal_reviewer", "final_reviewer", "limits"]);
const AGENT_PROFILE_FIELDS = new Set(["model", "reasoning_effort"]);
const AGENT_LIMIT_KEYS = [
  "maximum_implementation_iterations",
  "maximum_internal_review_rounds",
  "maximum_sol_review_rounds",
  "maximum_total_agent_turns",
  "maximum_turn_seconds",
  "maximum_total_seconds",
  "maximum_total_input_tokens",
  "maximum_total_output_tokens",
] as const;
const AGENT_LIMIT_FIELDS = new Set<string>(AGENT_LIMIT_KEYS);
const VERIFICATION_FIELDS = new Set(["allowed_executables", "allowed_environment_keys", "maximum_command_seconds", "maximum_output_bytes", "maximum_file_bytes", "maximum_changed_files", "maximum_diff_lines", "allowed_generated_paths"]);
const RUNTIME_FIELDS = new Set(["source", "codex_home"]);
const UI_FIELDS = new Set(["interactive"]);
const WEB_BRIDGE_FIELDS = new Set(["mode", "relay_url", "gpt_url", "poll_interval_ms", "job_ttl_seconds"]);

export const TRUSTED_CONFIG_HARD_LIMITS = {
  inbox: {
    poll_interval_ms: 60_000,
    stable_age_ms: 3_600_000,
    stable_observations: 16,
    maximum_candidates_per_scan: 10_000,
  },
  agents: {
    maximum_implementation_iterations: 64,
    maximum_internal_review_rounds: 32,
    maximum_sol_review_rounds: 16,
    maximum_total_agent_turns: 128,
    maximum_turn_seconds: 7_200,
    maximum_total_seconds: 86_400,
    maximum_total_input_tokens: 20_000_000,
    maximum_total_output_tokens: 4_000_000,
  },
  result_bundle: {
    maximum_entries: 4_096,
    maximum_entry_bytes: 67_108_864,
    maximum_source_file_bytes: 67_108_864,
    maximum_diff_bytes: 67_108_864,
    maximum_total_uncompressed_bytes: 536_870_912,
    maximum_archive_bytes: 268_435_456,
    maximum_public_output_bytes_per_command: 4_194_304,
    maximum_github_response_bytes: 8_388_608,
  },
  web_bridge: {
    poll_interval_ms: 60_000,
    job_ttl_seconds: 604_800,
  },
} as const;

function safeWebUrl(value: unknown, allowChatGpt = false): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (allowChatGpt) return parsed.protocol === "https:";
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
    return parsed.protocol === "https:" || loopback && parsed.protocol === "http:";
  } catch {
    return false;
  }
}

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

function positiveIntegerWithin(value: unknown, maximum: number): value is number {
  return positiveInteger(value) && value <= maximum;
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
      const maximum = TRUSTED_CONFIG_HARD_LIMITS.inbox[key];
      if (!positiveIntegerWithin(inbox[key], maximum)) add(issues, `inbox.${key} must be a positive integer <= ${maximum}.`);
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
  const runtime = value.runtime;
  if (runtime !== undefined) {
    if (!isRecord(runtime)) add(issues, "runtime must be an object.");
    else {
      for (const key of unknownFields(runtime, RUNTIME_FIELDS)) add(issues, `Unknown runtime configuration field: ${key}`);
      if (runtime.source !== "bundled") add(issues, 'runtime.source must equal "bundled".');
      if (runtime.codex_home !== undefined && (typeof runtime.codex_home !== "string" || !path.isAbsolute(runtime.codex_home) || runtime.codex_home.includes("\u0000"))) add(issues, "runtime.codex_home must be an absolute NUL-free path.");
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
        if (profile.reasoning_effort !== "minimal" && profile.reasoning_effort !== "low" && profile.reasoning_effort !== "medium" && profile.reasoning_effort !== "high" && profile.reasoning_effort !== "xhigh") add(issues, `agents.${key}.reasoning_effort is invalid.`);
      }
      const limits = agents.limits;
      if (!isRecord(limits)) add(issues, "agents.limits must be an object.");
      else {
        for (const field of unknownFields(limits, AGENT_LIMIT_FIELDS)) add(issues, `Unknown agents.limits field: ${field}`);
        for (const field of AGENT_LIMIT_KEYS) {
          const maximum = TRUSTED_CONFIG_HARD_LIMITS.agents[field];
          if (!positiveIntegerWithin(limits[field], maximum)) add(issues, `agents.limits.${field} must be a positive integer <= ${maximum}.`);
        }
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
  const publish = value.publish;
  if (publish !== undefined) {
    if (!isRecord(publish)) add(issues, "publish must be an object.");
    else {
      for (const key of unknownFields(publish, new Set(["identity", "authentication"]))) add(issues, `Unknown publish field: ${key}`);
      const identity = publish.identity;
      if (!isRecord(identity)) add(issues, "publish.identity must be an object.");
      else {
        for (const key of unknownFields(identity, new Set(["name", "email"]))) add(issues, `Unknown publish.identity field: ${key}`);
        if (typeof identity.name !== "string" || identity.name !== identity.name.trim() || identity.name.length < 1 || identity.name.length > 128 || /[\x00-\x1F\x7F<>]/.test(identity.name)) add(issues, "publish.identity.name is invalid.");
        if (typeof identity.email !== "string" || identity.email !== identity.email.trim() || identity.email.length < 3 || identity.email.length > 320 || /[\x00-\x1F\x7F]/.test(identity.email) || !/^[^@\s<>]+@[^@\s<>]+$/.test(identity.email)) add(issues, "publish.identity.email is invalid.");
      }
      const authentication = publish.authentication;
      if (!isRecord(authentication)) add(issues, "publish.authentication must be an object.");
      else {
        if ("token" in authentication) add(issues, "publish.authentication cannot have token field directly.");
        if (authentication.mode === "none") {
          if ("token_environment_key" in authentication) add(issues, "publish.authentication.mode none cannot have token field.");
        } else if (authentication.mode === "https_token") {
          if (typeof authentication.token_environment_key !== "string" || !/^WCO_GIT_[A-Z0-9_]{1,48}$/.test(authentication.token_environment_key)) add(issues, "publish.authentication.token_environment_key is invalid.");
        } else if (authentication.mode === "gh_cli") {
          if ("token_environment_key" in authentication) add(issues, "publish.authentication.mode gh_cli cannot have token fields.");
        } else {
          add(issues, "publish.authentication.mode is invalid.");
        }
        const allowedAuthFields = new Set(["mode", "token_environment_key"]);
        for (const key of unknownFields(authentication, allowedAuthFields)) add(issues, `Unknown publish.authentication field: ${key}`);
      }
    }
  }

  const githubPullRequest = value.github_pull_request;
  if (githubPullRequest !== undefined) {
    if (!isRecord(githubPullRequest)) add(issues, "github_pull_request must be an object.");
    else {
      for (const key of unknownFields(githubPullRequest, new Set(["provider", "authentication"]))) add(issues, `Unknown github_pull_request field: ${key}`);
      if (githubPullRequest.provider !== "github.com") add(issues, "github_pull_request.provider must be github.com.");
      const auth = githubPullRequest.authentication;
      if (!isRecord(auth)) add(issues, "github_pull_request.authentication must be an object.");
      else {
        for (const key of unknownFields(auth, new Set(["mode", "token_environment_key"]))) add(issues, `Unknown github_pull_request.authentication field: ${key}`);
        if ("token" in auth) add(issues, "github_pull_request.authentication cannot have token field directly.");
        if (auth.mode === "https_token") {
          if (typeof auth.token_environment_key !== "string" || !/^WCO_GITHUB_[A-Z0-9_]{1,48}$/.test(auth.token_environment_key)) add(issues, "github_pull_request.authentication.token_environment_key is invalid.");
        } else if (auth.mode === "gh_cli") {
          if ("token_environment_key" in auth) add(issues, "github_pull_request.authentication.mode gh_cli cannot have token fields.");
        } else add(issues, "github_pull_request.authentication.mode must be https_token or gh_cli.");
      }
    }
  }

  const resultBundle = value.result_bundle;
  if (resultBundle !== undefined) {
    if (!isRecord(resultBundle)) add(issues, "result_bundle must be an object.");
    else {
      const allowedFields = new Set([
        "maximum_entries", "maximum_entry_bytes", "maximum_source_file_bytes",
        "maximum_diff_bytes", "maximum_total_uncompressed_bytes", "maximum_archive_bytes",
        "maximum_public_output_bytes_per_command", "maximum_github_response_bytes",
        "github_attestation"
      ]);
      for (const key of unknownFields(resultBundle, allowedFields)) add(issues, `Unknown result_bundle field: ${key}`);
      for (const [field, maximum] of Object.entries(TRUSTED_CONFIG_HARD_LIMITS.result_bundle)) {
        if (resultBundle[field] !== undefined && !positiveIntegerWithin(resultBundle[field], maximum)) {
          add(issues, `result_bundle.${field} must be a positive integer <= ${maximum}.`);
        }
      }
      if (resultBundle.github_attestation !== undefined && resultBundle.github_attestation !== "required" && resultBundle.github_attestation !== "optional") {
        add(issues, "result_bundle.github_attestation must be 'required' or 'optional'.");
      }
    }
  }

  const ui = value.ui;
  if (ui !== undefined) {
    if (!isRecord(ui)) add(issues, "ui must be an object.");
    else {
      for (const key of unknownFields(ui, UI_FIELDS)) add(issues, `Unknown ui field: ${key}`);
      if (typeof ui.interactive !== "boolean") add(issues, "ui.interactive must be boolean.");
    }
  }

  const webBridge = value.web_bridge;
  if (webBridge !== undefined) {
    if (!isRecord(webBridge)) add(issues, "web_bridge must be an object.");
    else {
      for (const key of unknownFields(webBridge, WEB_BRIDGE_FIELDS)) add(issues, `Unknown web_bridge field: ${key}`);
      if (webBridge.mode !== "actions_relay" && webBridge.mode !== "manual_file") add(issues, "web_bridge.mode is invalid.");
      if (webBridge.mode === "actions_relay" && !safeWebUrl(webBridge.relay_url)) add(issues, "web_bridge.relay_url must be HTTPS or an HTTP loopback URL.");
      if (webBridge.relay_url !== undefined && !safeWebUrl(webBridge.relay_url)) add(issues, "web_bridge.relay_url is invalid.");
      if (webBridge.gpt_url !== undefined && !safeWebUrl(webBridge.gpt_url, true)) add(issues, "web_bridge.gpt_url must be an HTTPS URL without credentials or fragments.");
      if (!positiveIntegerWithin(webBridge.poll_interval_ms, TRUSTED_CONFIG_HARD_LIMITS.web_bridge.poll_interval_ms)) add(issues, `web_bridge.poll_interval_ms must be a positive integer <= ${TRUSTED_CONFIG_HARD_LIMITS.web_bridge.poll_interval_ms}.`);
      if (!positiveIntegerWithin(webBridge.job_ttl_seconds, TRUSTED_CONFIG_HARD_LIMITS.web_bridge.job_ttl_seconds)) add(issues, `web_bridge.job_ttl_seconds must be a positive integer <= ${TRUSTED_CONFIG_HARD_LIMITS.web_bridge.job_ttl_seconds}.`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [], config: value as unknown as TrustedConfig };
}
