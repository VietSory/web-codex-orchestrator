import type { BundleManifest } from "../bundle/contracts.js";
import type { ExecutionContract, ExecutionErrorCode, ExecutionIssue, ExecutionValidationReport } from "./contracts.js";
import { ExecutionContractError } from "./errors.js";

const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VERIFIER_GATE = "VERIFIER_PASS" as const;
const REVIEWER_GATE = "REVIEWER_APPROVE" as const;
const LEGACY_SOL_GATE = "SOL_APPROVE" as const;
const KNOWN_PUSH_GATES = new Set<string>([VERIFIER_GATE, REVIEWER_GATE, LEGACY_SOL_GATE]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function add(issues: ExecutionIssue[], code: ExecutionErrorCode, message: string): void {
  issues.push({ code, message });
}

/** Conservative local equivalent of git-check-ref-format. The authoritative
 * check is repeated by branch-policy using the Git runner.
 */
export function isPlausibleBranchName(value: string): boolean {
  if (!value || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("\\") || value.includes("//")) return false;
  if (value.endsWith(".lock") || /[\u0000-\u0020\u007f~^:?*\[\]]/.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith("."));
}

function isSafeBranchPrefix(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !value.endsWith("/") || value.startsWith("/") || value.includes("\\") || value.includes("..") || value.includes("//") || /[\u0000-\u0020\u007f~^:?*\[\]]/.test(value)) return false;
  return isPlausibleBranchName(value.slice(0, -1));
}

function validateCore(manifest: Record<string, unknown>, issues: ExecutionIssue[]): void {
  const repository = manifest.repository;
  const delivery = manifest.delivery;
  const policy = manifest.git_policy;

  if (!isRecord(repository) || !nonEmpty(repository.id) || !REPOSITORY_ID_PATTERN.test(repository.id)) {
    add(issues, "DELIVERY_CONTRACT_INVALID", "repository.id must match the trusted logical identifier pattern.");
  }
  if (!isRecord(repository) || !nonEmpty(repository.base_branch) || !isPlausibleBranchName(repository.base_branch)) {
    add(issues, "DELIVERY_CONTRACT_INVALID", "repository.base_branch is required.");
  }
  if (!isRecord(repository) || typeof repository.base_commit !== "string" || !FULL_COMMIT_PATTERN.test(repository.base_commit)) {
    add(issues, "BASE_COMMIT_INVALID", "repository.base_commit must be a full lowercase 40 or 64 character commit ID.");
  }

  if (!isRecord(delivery)) {
    add(issues, "DELIVERY_CONTRACT_INVALID", "delivery is required for an executable bundle.");
  } else {
    if (delivery.mode !== "github_pull_request") add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.mode must be github_pull_request.");
    if (!nonEmpty(delivery.remote)) add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.remote is required.");
    if (!nonEmpty(delivery.base_branch) || !isPlausibleBranchName(delivery.base_branch) || !isRecord(repository) || delivery.base_branch !== repository.base_branch) {
      add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.base_branch must equal repository.base_branch.");
    }
    if (!nonEmpty(delivery.branch_name) || !isPlausibleBranchName(delivery.branch_name)) {
      add(issues, "BRANCH_POLICY_VIOLATION", "delivery.branch_name is not a valid Git branch name.");
    }
    if (delivery.draft !== true) add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.draft must be true.");
    if (delivery.auto_merge !== false) add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.auto_merge must be false.");
    if (!Array.isArray(delivery.push_after)) {
      add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.push_after must be an array.");
    } else {
      const gates = delivery.push_after;
      if (gates.some((gate) => typeof gate !== "string" || !KNOWN_PUSH_GATES.has(gate))) add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.push_after contains an unknown gate.");
      if (new Set(gates).size !== gates.length) add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.push_after contains duplicate gates.");
      if (!gates.includes(VERIFIER_GATE)) add(issues, "DELIVERY_CONTRACT_INVALID", `delivery.push_after must contain ${VERIFIER_GATE}.`);
      const reviewGates = [REVIEWER_GATE, LEGACY_SOL_GATE].filter((gate) => gates.includes(gate));
      if (reviewGates.length !== 1) add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.push_after must contain exactly one reviewer approval gate (REVIEWER_APPROVE, or legacy SOL_APPROVE).");
      if (gates.length !== 2) add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.push_after must contain exactly verifier and reviewer approval gates.");
    }
  }

  if (!isRecord(policy)) {
    add(issues, "GIT_POLICY_INVALID", "git_policy is required for an executable bundle.");
  } else {
    if (!nonEmpty(policy.allowed_remote)) add(issues, "GIT_POLICY_INVALID", "git_policy.allowed_remote is required.");
    if (!nonEmpty(policy.allowed_branch_prefix) || !isSafeBranchPrefix(policy.allowed_branch_prefix)) add(issues, "GIT_POLICY_INVALID", "git_policy.allowed_branch_prefix is unsafe.");
    if (!Array.isArray(policy.deny_direct_push_branches) || !policy.deny_direct_push_branches.every((branch) => nonEmpty(branch) && isPlausibleBranchName(branch))) add(issues, "GIT_POLICY_INVALID", "git_policy.deny_direct_push_branches must contain valid branch names.");
    if (policy.allow_force_push !== false || policy.allow_remote_branch_delete !== false || policy.allow_merge !== false) add(issues, "GIT_POLICY_INVALID", "Force push, remote branch delete, and merge must all be disabled.");
  }
  if (isRecord(delivery) && isRecord(policy) && delivery.remote !== policy.allowed_remote) add(issues, "DELIVERY_CONTRACT_INVALID", "delivery.remote must equal git_policy.allowed_remote.");
  if (isRecord(delivery) && isRecord(policy) && typeof delivery.branch_name === "string" && typeof policy.allowed_branch_prefix === "string" && !delivery.branch_name.startsWith(policy.allowed_branch_prefix)) add(issues, "BRANCH_POLICY_VIOLATION", "branch_name does not use the allowed branch prefix.");
  if (isRecord(delivery) && isRecord(policy) && typeof delivery.branch_name === "string" && Array.isArray(policy.deny_direct_push_branches)) {
    const branchName = delivery.branch_name;
    if (policy.deny_direct_push_branches.some((denied) => branchName === denied || branchName.startsWith(`${denied}/`))) add(issues, "BRANCH_POLICY_VIOLATION", "branch_name is denied by git policy.");
  }
}

function toContract(manifest: Record<string, unknown>): ExecutionContract {
  const result = manifest as unknown as BundleManifest & { schema_version: "1.2" | "1.3" };
  return {
    schema_version: result.schema_version,
    task_id: result.task_id,
    title: result.title,
    repository: result.repository as ExecutionContract["repository"],
    delivery: result.delivery as ExecutionContract["delivery"],
    git_policy: result.git_policy as ExecutionContract["git_policy"],
    limits: result.limits,
    allowed_paths: result.allowed_paths,
    forbidden_paths: result.forbidden_paths,
  };
}

/** Phase 3 contract validation. Both 1.2 and 1.3 remain preparable. */
export function validateExecutionContract(manifest: unknown): ExecutionValidationReport {
  const issues: ExecutionIssue[] = [];
  if (!isRecord(manifest) || (manifest.schema_version !== "1.2" && manifest.schema_version !== "1.3")) {
    add(issues, "EXECUTION_CONTRACT_REQUIRED", "Only schema 1.2 or 1.3 bundles may be prepared.");
    return { ok: false, issues };
  }
  validateCore(manifest, issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [], contract: toContract(manifest) };
}

/** Phase 4 requires the structured validation contract introduced by 1.3. */
export function validatePhase4ExecutionContract(manifest: unknown): ExecutionValidationReport {
  const issues: ExecutionIssue[] = [];
  if (!isRecord(manifest) || manifest.schema_version !== "1.3") {
    add(issues, "EXECUTION_SCHEMA_UPGRADE_REQUIRED", "Phase 4 requires schema 1.3 bundles.");
    return { ok: false, issues };
  }
  if (manifest.agents !== undefined || manifest.network !== undefined || manifest.sandbox !== undefined || manifest.verification !== undefined || manifest.sandbox_mode !== undefined || manifest.model !== undefined || manifest.reasoning_effort !== undefined) {
    add(issues, "DELIVERY_CONTRACT_INVALID", "Agent, network, and sandbox selection must come from trusted configuration.");
  }
  validateCore(manifest, issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [], contract: toContract(manifest) };
}

export function assertExecutionContract(manifest: unknown): ExecutionContract {
  const report = validateExecutionContract(manifest);
  if (!report.ok || !report.contract) {
    const issue = report.issues[0];
    throw new ExecutionContractError(issue?.code ?? "DELIVERY_CONTRACT_INVALID", issue?.message ?? "Invalid execution contract.");
  }
  return report.contract;
}

export function assertPhase4ExecutionContract(manifest: unknown): ExecutionContract {
  const report = validatePhase4ExecutionContract(manifest);
  if (!report.ok || !report.contract) {
    const issue = report.issues[0];
    throw new ExecutionContractError(issue?.code ?? "DELIVERY_CONTRACT_INVALID", issue?.message ?? "Invalid Phase 4 execution contract.");
  }
  return report.contract;
}

export const validateExecutionManifest = validateExecutionContract;
