import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  AcceptanceContract,
  BundleManifest,
  RiskPolicy,
  TestMatrix,
  ValidationContract,
} from "./contracts.js";

const REQUIRED_FILES = [
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

export interface ValidationReport {
  ok: boolean;
  checks: string[];
  errors: string[];
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

function assertRecord(value: unknown, label: string, errors: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
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

function validateManifest(value: unknown, errors: string[]): value is BundleManifest {
  if (!assertRecord(value, "manifest.json", errors)) return false;

  if (value.schema_version !== "1.0") {
    errors.push('manifest.schema_version must equal "1.0".');
  }
  if (!isNonEmptyString(value.task_id) || !/^[A-Za-z0-9._-]+$/.test(value.task_id)) {
    errors.push("manifest.task_id must contain only letters, numbers, dot, underscore, or hyphen.");
  }
  if (!isNonEmptyString(value.title)) {
    errors.push("manifest.title is required.");
  }

  if (!assertRecord(value.repository, "manifest.repository", errors)) {
    return false;
  } else {
    if (!isNonEmptyString(value.repository.base_branch)) {
      errors.push("manifest.repository.base_branch is required.");
    }
    if (!isNonEmptyString(value.repository.base_commit)) {
      errors.push("manifest.repository.base_commit is required.");
    }
  }

  if (!assertRecord(value.limits, "manifest.limits", errors)) {
    return false;
  } else {
    for (const key of [
      "max_internal_iterations",
      "max_review_rounds",
      "max_changed_files",
      "max_diff_lines",
    ] as const) {
      if (!isPositiveInteger(value.limits[key])) {
        errors.push(`manifest.limits.${key} must be a positive integer.`);
      }
    }
  }

  for (const key of ["allowed_paths", "forbidden_paths"] as const) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isNonEmptyString)) {
      errors.push(`manifest.${key} must be a non-empty string array.`);
      continue;
    }

    for (const entry of entries) {
      const pathError = validateSafeRelativePath(entry);
      if (pathError) errors.push(`manifest.${key}: ${pathError}`);
    }
  }

  if (Array.isArray(value.allowed_paths) && Array.isArray(value.forbidden_paths)) {
    const allowed = new Set(value.allowed_paths.filter(isNonEmptyString));
    for (const forbidden of value.forbidden_paths.filter(isNonEmptyString)) {
      if (allowed.has(forbidden)) {
        errors.push(`Path cannot be both allowed and forbidden: ${forbidden}`);
      }
    }
  }

  return errors.length === 0;
}

function validateAcceptance(value: unknown, errors: string[]): value is AcceptanceContract {
  if (!assertRecord(value, "acceptance.json", errors)) return false;
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    errors.push("acceptance.criteria must be a non-empty array.");
    return false;
  }

  const ids = new Set<string>();
  for (const [index, item] of value.criteria.entries()) {
    const label = `acceptance.criteria[${index}]`;
    if (!assertRecord(item, label, errors)) continue;

    if (!isNonEmptyString(item.id)) errors.push(`${label}.id is required.`);
    else if (ids.has(item.id)) errors.push(`Duplicate acceptance ID: ${item.id}`);
    else ids.add(item.id);

    if (!isNonEmptyString(item.description)) errors.push(`${label}.description is required.`);
    if (typeof item.required !== "boolean") errors.push(`${label}.required must be boolean.`);

    if (!assertRecord(item.verification, `${label}.verification`, errors)) continue;
    const type = item.verification.type;
    if (!["automated-test", "command", "manual-review"].includes(String(type))) {
      errors.push(`${label}.verification.type is invalid.`);
    }

    if (type !== "manual-review" && !isNonEmptyString(item.verification.reference)) {
      errors.push(`${label}.verification.reference is required for ${String(type)}.`);
    }
  }

  return errors.length === 0;
}

function validateTestMatrix(value: unknown, errors: string[]): value is TestMatrix {
  if (!assertRecord(value, "test-matrix.json", errors)) return false;
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    errors.push("test-matrix.cases must be a non-empty array.");
    return false;
  }

  const ids = new Set<string>();
  for (const [index, item] of value.cases.entries()) {
    const label = `test-matrix.cases[${index}]`;
    if (!assertRecord(item, label, errors)) continue;

    if (!isNonEmptyString(item.id)) errors.push(`${label}.id is required.`);
    else if (ids.has(item.id)) errors.push(`Duplicate test case ID: ${item.id}`);
    else ids.add(item.id);

    if (!isNonEmptyString(item.category)) errors.push(`${label}.category is required.`);
    if (!Array.isArray(item.given) || !item.given.every(isNonEmptyString)) {
      errors.push(`${label}.given must be a string array.`);
    }
    if (!isNonEmptyString(item.when)) errors.push(`${label}.when is required.`);
    if (!Array.isArray(item.then) || item.then.length === 0 || !item.then.every(isNonEmptyString)) {
      errors.push(`${label}.then must be a non-empty string array.`);
    }
  }

  return errors.length === 0;
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

function validateValidationContract(value: unknown, errors: string[]): value is ValidationContract {
  if (!assertRecord(value, "validation.json", errors)) return false;
  if (!Array.isArray(value.commands) || value.commands.length === 0) {
    errors.push("validation.commands must be a non-empty array.");
    return false;
  }

  const ids = new Set<string>();
  for (const [index, item] of value.commands.entries()) {
    const label = `validation.commands[${index}]`;
    if (!assertRecord(item, label, errors)) continue;

    if (!isNonEmptyString(item.id)) errors.push(`${label}.id is required.`);
    else if (ids.has(item.id)) errors.push(`Duplicate validation command ID: ${item.id}`);
    else ids.add(item.id);

    if (!isNonEmptyString(item.command)) {
      errors.push(`${label}.command is required.`);
    } else {
      const commandError = validateCommand(item.command);
      if (commandError) errors.push(commandError);
    }

    if (typeof item.required !== "boolean") errors.push(`${label}.required must be boolean.`);
    if (!isPositiveInteger(item.timeout_seconds) || item.timeout_seconds > 3600) {
      errors.push(`${label}.timeout_seconds must be an integer from 1 to 3600.`);
    }
  }

  return errors.length === 0;
}

function validateRiskPolicy(value: unknown, errors: string[]): value is RiskPolicy {
  if (!assertRecord(value, "risk-policy.json", errors)) return false;
  if (
    !Array.isArray(value.human_approval_required_for) ||
    value.human_approval_required_for.length === 0 ||
    !value.human_approval_required_for.every(isNonEmptyString)
  ) {
    errors.push("risk-policy.human_approval_required_for must be a non-empty string array.");
  }
  return errors.length === 0;
}

async function readJson(filePath: string, errors: string[]): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${path.basename(filePath)} is not valid JSON: ${message}`);
    return undefined;
  }
}

function crossValidate(
  acceptance: AcceptanceContract,
  testMatrix: TestMatrix,
  validation: ValidationContract,
  errors: string[],
): void {
  const testIds = new Set(testMatrix.cases.map((item) => item.id));
  const commandIds = new Set(validation.commands.map((item) => item.id));

  for (const criterion of acceptance.criteria) {
    const reference = criterion.verification.reference;
    if (!reference) continue;

    if (criterion.verification.type === "automated-test" && !testIds.has(reference)) {
      errors.push(`${criterion.id} references missing test case: ${reference}`);
    }

    if (criterion.verification.type === "command" && !commandIds.has(reference)) {
      errors.push(`${criterion.id} references missing validation command: ${reference}`);
    }
  }
}

export async function validateBundleDirectory(bundleDirectory: string): Promise<ValidationReport> {
  const checks: string[] = [];
  const errors: string[] = [];
  const resolved = path.resolve(bundleDirectory);

  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      return { ok: false, checks, errors: [`Bundle path is not a directory: ${resolved}`] };
    }
  } catch {
    return { ok: false, checks, errors: [`Bundle directory does not exist: ${resolved}`] };
  }

  for (const fileName of REQUIRED_FILES) {
    try {
      await access(path.join(resolved, fileName));
    } catch {
      errors.push(`Missing required file: ${fileName}`);
    }
  }

  if (errors.length > 0) return { ok: false, checks, errors };
  checks.push("Required bundle files are present.");

  const manifestRaw = await readJson(path.join(resolved, "manifest.json"), errors);
  const acceptanceRaw = await readJson(path.join(resolved, "acceptance.json"), errors);
  const testMatrixRaw = await readJson(path.join(resolved, "test-matrix.json"), errors);
  const validationRaw = await readJson(path.join(resolved, "validation.json"), errors);
  const riskPolicyRaw = await readJson(path.join(resolved, "risk-policy.json"), errors);

  if (errors.length > 0) return { ok: false, checks, errors };
  checks.push("JSON files have valid syntax.");

  const sectionErrors: string[] = [];

  const manifestOk = validateManifest(manifestRaw, sectionErrors);
  if (manifestOk) checks.push("Manifest contract is valid.");

  const acceptanceOk = validateAcceptance(acceptanceRaw, sectionErrors);
  if (acceptanceOk) checks.push("Acceptance contract is valid.");

  const testMatrixOk = validateTestMatrix(testMatrixRaw, sectionErrors);
  if (testMatrixOk) checks.push("Test matrix is valid.");

  const validationOk = validateValidationContract(validationRaw, sectionErrors);
  if (validationOk) checks.push("Validation commands are allowed.");

  const riskPolicyOk = validateRiskPolicy(riskPolicyRaw, sectionErrors);
  if (riskPolicyOk) checks.push("Risk policy is valid.");

  errors.push(...sectionErrors);

  if (
    acceptanceOk &&
    testMatrixOk &&
    validationOk &&
    acceptanceRaw &&
    testMatrixRaw &&
    validationRaw
  ) {
    const crossErrors: string[] = [];
    crossValidate(
      acceptanceRaw as AcceptanceContract,
      testMatrixRaw as TestMatrix,
      validationRaw as ValidationContract,
      crossErrors,
    );

    if (crossErrors.length === 0) checks.push("Acceptance references resolve correctly.");
    errors.push(...crossErrors);
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}
