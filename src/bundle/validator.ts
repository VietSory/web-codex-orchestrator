import { access, stat } from "node:fs/promises";
import path from "node:path";

import type {
  AcceptanceContract,
  BundleManifest,
  BundlePayload,
  RiskPolicy,
  TestMatrix,
  ValidationContract,
} from "./contracts.js";
import { readJsonFile } from "../shared/read-json.js";

const REQUIRED_FILES_V1_0 = [
  "manifest.json",
  "request.md",
  "research.md",
  "sources.md",
  "plan.md",
  "rules.md",
  "acceptance.json",
  "test-matrix.json",
  "validation.json",
  "risk-policy.json",
] as const;

const REQUIRED_FILES_V1_1 = [
  "manifest.json",
  "README.md",
  "REQUEST.md",
  "RESEARCH.md",
  "SOURCES.md",
  "PLAN.md",
  "RULES.md",
  "VALIDATION.md",
  "acceptance.json",
  "test-matrix.json",
  "validation.json",
  "risk-policy.json",
  "checksums.json",
] as const;

const REQUIRED_FILES_V1_2 = REQUIRED_FILES_V1_1;
const REQUIRED_FILES_V1_3 = REQUIRED_FILES_V1_1;

const TASK_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const SHELL_META_PATTERN = /[;&|><`$]|\r|\n/;

const ALLOWED_COMMAND_PREFIXES = [
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run typecheck",
  "npm run build",
  "pnpm test",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm build",
  "yarn test",
  "yarn lint",
  "yarn typecheck",
  "yarn build",
  "go test",
  "go vet",
  "pytest",
  "python -m pytest",
] as const;

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bkubectl\s+delete\b/i,
  /\bhelm\s+uninstall\b/i,
  /\bterraform\s+destroy\b/i,
  /\bdrop\s+(database|table)\b/i,
  /\btruncate\s+table\b/i,
  /\bnpm\s+publish\b/i,
  /\bdocker\s+push\b/i,
] as const;

export type BundleValidationErrorCode =
  | "BUNDLE_CONTRACT_INVALID"
  | "PAYLOAD_CONTRACT_INVALID";

export interface BundleValidationIssue {
  code: BundleValidationErrorCode;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: string[];
  /** Kept for the Phase 1 public API. Prefer issues for stable codes. */
  errors: string[];
  issues: BundleValidationIssue[];
  manifest?: BundleManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function addIssue(
  issues: BundleValidationIssue[],
  message: string,
  code: BundleValidationErrorCode = "BUNDLE_CONTRACT_INVALID",
): void {
  issues.push({ code, message });
}

function assertRecord(
  value: unknown,
  label: string,
  issues: BundleValidationIssue[],
  code: BundleValidationErrorCode = "BUNDLE_CONTRACT_INVALID",
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    addIssue(issues, `${label} must be an object.`, code);
    return false;
  }
  return true;
}

function validateSafeRelativePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").trim();

  if (!normalized) return "Path cannot be empty.";
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    return `Absolute path is not allowed: ${value}`;
  }

  const segments = normalized.split("/");
  if (segments.includes("..")) {
    return `Parent traversal is not allowed: ${value}`;
  }

  if (normalized === "*" || normalized === "**" || normalized === "**/*") {
    return `Path scope is too broad: ${value}`;
  }

  return null;
}

function validatePayload(value: unknown, issues: BundleValidationIssue[]): value is BundlePayload {
  if (!assertRecord(value, "manifest.payload", issues, "PAYLOAD_CONTRACT_INVALID")) return false;

  const type = value.type;
  if (type !== "none" && type !== "apply-script" && type !== "patch" && type !== "files") {
    addIssue(issues, "manifest.payload.type is invalid.", "PAYLOAD_CONTRACT_INVALID");
  }
  if (value.review_before_execution !== true) {
    addIssue(
      issues,
      "manifest.payload.review_before_execution must be true.",
      "PAYLOAD_CONTRACT_INVALID",
    );
  }

  const entrypoint = value.entrypoint;
  if (type === "none" && entrypoint !== undefined) {
    addIssue(
      issues,
      "manifest.payload.type none must not contain entrypoint.",
      "PAYLOAD_CONTRACT_INVALID",
    );
  }
  if ((type === "apply-script" || type === "patch") && !isNonEmptyString(entrypoint)) {
    addIssue(
      issues,
      `manifest.payload.entrypoint is required for ${type}.`,
      "PAYLOAD_CONTRACT_INVALID",
    );
  }
  if (entrypoint !== undefined && !isNonEmptyString(entrypoint)) {
    addIssue(
      issues,
      "manifest.payload.entrypoint must be a non-empty string.",
      "PAYLOAD_CONTRACT_INVALID",
    );
  }
  if (isNonEmptyString(entrypoint)) {
    if (entrypoint.includes("\\") || !entrypoint.startsWith("payload/")) {
      addIssue(
        issues,
        "manifest.payload.entrypoint must be a safe path below payload/.",
        "PAYLOAD_CONTRACT_INVALID",
      );
    } else {
      const pathError = validateSafeRelativePath(entrypoint);
      if (pathError || entrypoint.split("/").includes(".")) {
        addIssue(
          issues,
          `manifest.payload.entrypoint is unsafe: ${pathError ?? entrypoint}`,
          "PAYLOAD_CONTRACT_INVALID",
        );
      }
    }
  }

  return !issues.some((issue) => issue.code === "PAYLOAD_CONTRACT_INVALID");
}

function validateManifest(value: unknown, issues: BundleValidationIssue[]): value is BundleManifest {
  if (!assertRecord(value, "manifest.json", issues)) return false;

  if (value.schema_version !== "1.0" && value.schema_version !== "1.1" && value.schema_version !== "1.2" && value.schema_version !== "1.3") {
    addIssue(issues, 'manifest.schema_version must equal "1.0", "1.1", "1.2", or "1.3".');
  }
  if (!isNonEmptyString(value.task_id) || !TASK_ID_PATTERN.test(value.task_id)) {
    addIssue(
      issues,
      "manifest.task_id must be 1-128 characters, start with a letter or number, and must not equal . or ..",
    );
  }
  if (!isNonEmptyString(value.title)) {
    addIssue(issues, "manifest.title is required.");
  }

  if (!assertRecord(value.repository, "manifest.repository", issues)) {
    return false;
  } else {
    if (!isNonEmptyString(value.repository.base_branch)) {
      addIssue(issues, "manifest.repository.base_branch is required.");
    }
    if (!isNonEmptyString(value.repository.base_commit)) {
      addIssue(issues, "manifest.repository.base_commit is required.");
    }
  }

  if (!assertRecord(value.limits, "manifest.limits", issues)) {
    return false;
  } else {
    for (const key of [
      "max_internal_iterations",
      "max_review_rounds",
      "max_changed_files",
      "max_diff_lines",
    ] as const) {
      if (!isPositiveInteger(value.limits[key])) {
        addIssue(issues, `manifest.limits.${key} must be a positive integer.`);
      }
    }
  }

  for (const key of ["allowed_paths", "forbidden_paths"] as const) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isNonEmptyString)) {
      addIssue(issues, `manifest.${key} must be a non-empty string array.`);
      continue;
    }

    for (const entry of entries) {
      const pathError = validateSafeRelativePath(entry);
      if (pathError) addIssue(issues, `manifest.${key}: ${pathError}`);
    }
  }

  if (Array.isArray(value.allowed_paths) && Array.isArray(value.forbidden_paths)) {
    const allowed = new Set(value.allowed_paths.filter(isNonEmptyString));
    for (const forbidden of value.forbidden_paths.filter(isNonEmptyString)) {
      if (allowed.has(forbidden)) {
        addIssue(issues, `Path cannot be both allowed and forbidden: ${forbidden}`);
      }
    }
  }

  if (value.payload !== undefined) validatePayload(value.payload, issues);

  return !issues.some((issue) => issue.code === "BUNDLE_CONTRACT_INVALID" || issue.code === "PAYLOAD_CONTRACT_INVALID");
}

function validateAcceptance(value: unknown, issues: BundleValidationIssue[]): value is AcceptanceContract {
  if (!assertRecord(value, "acceptance.json", issues)) return false;
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    addIssue(issues, "acceptance.criteria must be a non-empty array.");
    return false;
  }

  const ids = new Set<string>();
  for (const [index, item] of value.criteria.entries()) {
    const label = `acceptance.criteria[${index}]`;
    if (!assertRecord(item, label, issues)) continue;

    if (!isNonEmptyString(item.id)) addIssue(issues, `${label}.id is required.`);
    else if (ids.has(item.id)) addIssue(issues, `Duplicate acceptance ID: ${item.id}`);
    else ids.add(item.id);

    if (!isNonEmptyString(item.description)) addIssue(issues, `${label}.description is required.`);
    if (typeof item.required !== "boolean") addIssue(issues, `${label}.required must be boolean.`);

    if (!assertRecord(item.verification, `${label}.verification`, issues)) continue;
    const type = item.verification.type;
    if (!['automated-test', 'command', 'manual-review'].includes(String(type))) {
      addIssue(issues, `${label}.verification.type is invalid.`);
    }

    if (type !== "manual-review" && !isNonEmptyString(item.verification.reference)) {
      addIssue(issues, `${label}.verification.reference is required for ${String(type)}.`);
    }
  }

  return !issues.some((issue) => issue.code === "BUNDLE_CONTRACT_INVALID");
}

function validateTestMatrix(value: unknown, issues: BundleValidationIssue[]): value is TestMatrix {
  if (!assertRecord(value, "test-matrix.json", issues)) return false;
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    addIssue(issues, "test-matrix.cases must be a non-empty array.");
    return false;
  }

  const ids = new Set<string>();
  for (const [index, item] of value.cases.entries()) {
    const label = `test-matrix.cases[${index}]`;
    if (!assertRecord(item, label, issues)) continue;

    if (!isNonEmptyString(item.id)) addIssue(issues, `${label}.id is required.`);
    else if (ids.has(item.id)) addIssue(issues, `Duplicate test case ID: ${item.id}`);
    else ids.add(item.id);

    if (!isNonEmptyString(item.category)) addIssue(issues, `${label}.category is required.`);
    if (!Array.isArray(item.given) || !item.given.every(isNonEmptyString)) {
      addIssue(issues, `${label}.given must be a string array.`);
    }
    if (!isNonEmptyString(item.when)) addIssue(issues, `${label}.when is required.`);
    if (!Array.isArray(item.then) || item.then.length === 0 || !item.then.every(isNonEmptyString)) {
      addIssue(issues, `${label}.then must be a non-empty string array.`);
    }
  }

  return !issues.some((issue) => issue.code === "BUNDLE_CONTRACT_INVALID");
}

function validateCommand(command: string): string | null {
  const trimmed = command.trim();

  if (SHELL_META_PATTERN.test(trimmed)) {
    return `Shell operators or substitutions are not allowed: ${command}`;
  }

  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) return `Dangerous command is not allowed: ${command}`;
  }

  const allowed = ALLOWED_COMMAND_PREFIXES.some(
    (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `),
  );

  return allowed ? null : `Command is not on the phase-1 allowlist: ${command}`;
}

const VALIDATION_EXECUTABLE_PATTERN = /^[A-Za-z0-9._+-]+$/;
const VALIDATION_SHELL_META_PATTERN = /[;&|><`$(){}\r\n]/;
const VALIDATION_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function validateStructuredValidationCommand(
  item: Record<string, unknown>,
  label: string,
  issues: BundleValidationIssue[],
): boolean {
  const allowedFields = new Set(["id", "executable", "args", "cwd", "environment", "required", "timeout_seconds", "maximum_output_bytes"]);
  for (const key of Object.keys(item)) if (!allowedFields.has(key)) addIssue(issues, `${label} contains an unknown field: ${key}`);
  if (typeof item.command === "string") {
    if (SHELL_META_PATTERN.test(item.command)) addIssue(issues, `Shell operators or substitutions are not allowed: ${item.command}`);
    addIssue(issues, `${label}.command is not allowed in schema 1.3; use executable and args.`);
  }
  if (typeof item.executable !== "string" || !item.executable || !VALIDATION_EXECUTABLE_PATTERN.test(item.executable) || item.executable.includes("/") || item.executable.includes("\\") || /\s/.test(item.executable) || VALIDATION_SHELL_META_PATTERN.test(item.executable)) {
    addIssue(issues, `${label}.executable must be a simple executable name.`);
  }
  if (!Array.isArray(item.args) || item.args.length > 256 || !item.args.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\u0000"))) {
    addIssue(issues, `${label}.args must be an array of strings without NUL bytes.`);
  }
  if (typeof item.cwd !== "string" || !item.cwd || item.cwd.startsWith("/") || item.cwd.startsWith("\\") || /^[A-Za-z]:/.test(item.cwd) || item.cwd.split(/[\\/]/).includes("..")) {
    addIssue(issues, `${label}.cwd must be a safe relative directory inside the worktree.`);
  }
  if (!isRecord(item.environment)) {
    addIssue(issues, `${label}.environment must be an object.`);
  } else {
    const denied = new Set(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SHELL", "COMSPEC", "CODEX_HOME", "BASH_ENV", "ENV", "CDPATH", "IFS", "GIT_DIR", "GIT_WORK_TREE", "NODE_OPTIONS", "PYTHONPATH", "LD_PRELOAD", "SSH_AUTH_SOCK", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]);
    for (const [key, value] of Object.entries(item.environment)) {
      if (!VALIDATION_ENVIRONMENT_KEY_PATTERN.test(key) || denied.has(key) || /^GIT_CONFIG/i.test(key) || /^DYLD_/i.test(key) || /TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PROXY/i.test(key) || typeof value !== "string" || value.length > 1024 || value.includes("\u0000") || VALIDATION_SHELL_META_PATTERN.test(value)) {
        addIssue(issues, `${label}.environment contains a denied or unsafe entry.`);
      }
    }
  }
  if (!isPositiveInteger(item.timeout_seconds) || item.timeout_seconds > 3600) {
    addIssue(issues, `${label}.timeout_seconds must be an integer from 1 to 3600.`);
  }
  if (!isPositiveInteger(item.maximum_output_bytes) || item.maximum_output_bytes > 10_000_000) {
    addIssue(issues, `${label}.maximum_output_bytes must be a positive bounded integer.`);
  }
  if (typeof item.required !== "boolean") addIssue(issues, `${label}.required must be boolean.`);
  return true;
}

function validateValidationContract(value: unknown, issues: BundleValidationIssue[], schemaVersion: unknown): value is ValidationContract {
  if (!assertRecord(value, "validation.json", issues)) return false;
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.length > 256) {
    addIssue(issues, "validation.commands must be a bounded non-empty array.");
    return false;
  }

  const ids = new Set<string>();
  for (const [index, item] of value.commands.entries()) {
    const label = `validation.commands[${index}]`;
    if (!assertRecord(item, label, issues)) continue;

    if (!isNonEmptyString(item.id)) addIssue(issues, `${label}.id is required.`);
    else if (ids.has(item.id)) addIssue(issues, `Duplicate validation command ID: ${item.id}`);
    else ids.add(item.id);

    if (schemaVersion === "1.3" || (item.command === undefined && item.executable !== undefined)) {
      validateStructuredValidationCommand(item, label, issues);
    } else {
      if (!isNonEmptyString(item.command)) {
        addIssue(issues, `${label}.command is required.`);
      } else {
        const commandError = validateCommand(item.command);
        if (commandError) addIssue(issues, commandError);
      }

      if (typeof item.required !== "boolean") addIssue(issues, `${label}.required must be boolean.`);
      if (!isPositiveInteger(item.timeout_seconds) || item.timeout_seconds > 3600) {
        addIssue(issues, `${label}.timeout_seconds must be an integer from 1 to 3600.`);
      }
    }
  }

  return !issues.some((issue) => issue.code === "BUNDLE_CONTRACT_INVALID");
}

function validateRiskPolicy(value: unknown, issues: BundleValidationIssue[]): value is RiskPolicy {
  if (!assertRecord(value, "risk-policy.json", issues)) return false;
  if (
    !Array.isArray(value.human_approval_required_for) ||
    value.human_approval_required_for.length === 0 ||
    !value.human_approval_required_for.every(isNonEmptyString)
  ) {
    addIssue(issues, "risk-policy.human_approval_required_for must be a non-empty string array.");
  }
  return !issues.some((issue) => issue.code === "BUNDLE_CONTRACT_INVALID");
}

async function readJson(
  filePath: string,
  issues: BundleValidationIssue[],
): Promise<unknown | undefined> {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addIssue(issues, `${path.basename(filePath)} is not valid JSON: ${message}`);
    return undefined;
  }
}

function crossValidate(
  acceptance: AcceptanceContract,
  testMatrix: TestMatrix,
  validation: ValidationContract,
  issues: BundleValidationIssue[],
): void {
  const testIds = new Set(testMatrix.cases.map((item) => item.id));
  const commandIds = new Set(validation.commands.map((item) => item.id));

  for (const criterion of acceptance.criteria) {
    const reference = criterion.verification.reference;
    if (!reference) continue;

    if (criterion.verification.type === "automated-test" && !testIds.has(reference)) {
      addIssue(issues, `${criterion.id} references missing test case: ${reference}`);
    }

    if (criterion.verification.type === "command" && !commandIds.has(reference)) {
      addIssue(issues, `${criterion.id} references missing validation command: ${reference}`);
    }
  }
}

async function validatePayloadEntrypoint(
  bundleDirectory: string,
  manifest: BundleManifest,
  issues: BundleValidationIssue[],
): Promise<void> {
  const payload = manifest.payload;
  if (!payload?.entrypoint) return;

  const resolved = path.resolve(bundleDirectory, payload.entrypoint);
  const rootWithSeparator = `${path.resolve(bundleDirectory)}${path.sep}`;
  if (!resolved.startsWith(rootWithSeparator)) {
    addIssue(issues, "manifest.payload.entrypoint escapes the bundle directory.", "PAYLOAD_CONTRACT_INVALID");
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      addIssue(issues, "manifest.payload.entrypoint must reference a regular file.", "PAYLOAD_CONTRACT_INVALID");
    }
  } catch {
    addIssue(issues, "manifest.payload.entrypoint does not exist.", "PAYLOAD_CONTRACT_INVALID");
  }
}

function report(checks: string[], issues: BundleValidationIssue[], manifest?: BundleManifest): ValidationReport {
  const result: ValidationReport = {
    ok: issues.length === 0,
    checks,
    errors: issues.map((issue) => issue.message),
    issues,
  };
  if (manifest) result.manifest = manifest;
  return result;
}

/** Validates metadata only. It never runs payloads or validation commands. */
export async function validateBundleDirectory(bundleDirectory: string): Promise<ValidationReport> {
  const checks: string[] = [];
  const issues: BundleValidationIssue[] = [];
  const resolved = path.resolve(bundleDirectory);

  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      addIssue(issues, `Bundle path is not a directory: ${resolved}`);
      return report(checks, issues);
    }
  } catch {
    addIssue(issues, `Bundle directory does not exist: ${resolved}`);
    return report(checks, issues);
  }

  try {
    await access(path.join(resolved, "manifest.json"));
  } catch {
    addIssue(issues, "Missing required file: manifest.json");
    return report(checks, issues);
  }

  const manifestRaw = await readJson(path.join(resolved, "manifest.json"), issues);
  if (issues.length > 0 || manifestRaw === undefined) return report(checks, issues);

  const manifestIssues: BundleValidationIssue[] = [];
  const manifestOk = validateManifest(manifestRaw, manifestIssues);
  const schemaVersion = isRecord(manifestRaw) ? manifestRaw.schema_version : undefined;
  const requiredFiles = schemaVersion === "1.3"
    ? REQUIRED_FILES_V1_3
    : schemaVersion === "1.2"
    ? REQUIRED_FILES_V1_2
    : schemaVersion === "1.1" ? REQUIRED_FILES_V1_1 : REQUIRED_FILES_V1_0;

  for (const fileName of requiredFiles) {
    try {
      await access(path.join(resolved, fileName));
    } catch {
      addIssue(issues, `Missing required file: ${fileName}`);
    }
  }
  if (issues.length > 0) return report(checks, issues);
  checks.push("Required bundle files are present.");

  const acceptanceRaw = await readJson(path.join(resolved, "acceptance.json"), issues);
  const testMatrixRaw = await readJson(path.join(resolved, "test-matrix.json"), issues);
  const validationRaw = await readJson(path.join(resolved, "validation.json"), issues);
  const riskPolicyRaw = await readJson(path.join(resolved, "risk-policy.json"), issues);

  if (issues.length > 0) return report(checks, issues);
  checks.push("JSON files have valid syntax.");

  const sectionIssues = [...manifestIssues];
  if (manifestOk) checks.push("Manifest contract is valid.");

  const acceptanceOk = validateAcceptance(acceptanceRaw, sectionIssues);
  if (acceptanceOk) checks.push("Acceptance contract is valid.");

  const testMatrixOk = validateTestMatrix(testMatrixRaw, sectionIssues);
  if (testMatrixOk) checks.push("Test matrix is valid.");

  const validationOk = validateValidationContract(validationRaw, sectionIssues, schemaVersion);
  if (validationOk) checks.push("Validation commands are allowed.");

  const riskPolicyOk = validateRiskPolicy(riskPolicyRaw, sectionIssues);
  if (riskPolicyOk) checks.push("Risk policy is valid.");

  if (acceptanceOk && testMatrixOk && validationOk && acceptanceRaw && testMatrixRaw && validationRaw) {
    const crossIssues: BundleValidationIssue[] = [];
    crossValidate(
      acceptanceRaw as AcceptanceContract,
      testMatrixRaw as TestMatrix,
      validationRaw as ValidationContract,
      crossIssues,
    );
    if (crossIssues.length === 0) checks.push("Acceptance references resolve correctly.");
    sectionIssues.push(...crossIssues);
  }

  const manifest = manifestOk ? (manifestRaw as BundleManifest) : undefined;
  if (manifest) await validatePayloadEntrypoint(resolved, manifest, sectionIssues);

  return report(checks, sectionIssues, manifest);
}
