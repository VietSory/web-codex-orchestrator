import crypto from "node:crypto";
import { ExecutionError } from "../execution/errors.js";
import type { AgentAssessment, AgentImplementationResult, ReviewFinding, ReviewResult, ReviewerRepairOperation } from "../execution/contracts.js";
import path from "node:path";
import { assertSeniorReviewFindingLocations } from "./reviewer-policy.js";

const MAX_REPAIR_OPERATIONS = 16;
const MAX_REPAIR_PAYLOAD_BYTES = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function stringArray(value: unknown, maximum = 256, maximumLength = 4_096): value is string[] { return Array.isArray(value) && value.length <= maximum && value.every((entry) => typeof entry === "string" && entry.length <= maximumLength); }
function safeRelative(value: string): boolean { return value.length > 0 && value.length <= 512 && !value.includes("\u0000") && !value.includes("\\") && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split("/").includes(".."); }
function safeEvidence(value: string): boolean {
  if (value.includes("\u0000") || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const location = value.split(/[:#]/, 1)[0]?.trim() ?? "";
  return !location.split("/").includes("..");
}

function validateRepairOperation(value: unknown): value is ReviewerRepairOperation {
  if (!record(value) || !exactKeys(value, ["op_id", "kind", "path", "preimage_sha256", "postimage_base64", "postimage_sha256"])) return false;
  if (typeof value.op_id !== "string" || value.op_id.length < 1 || value.op_id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value.op_id)) return false;
  if (!["create_file", "replace_file", "delete_file"].includes(String(value.kind)) || typeof value.path !== "string" || !safeRelative(value.path)) return false;
  if (!(value.preimage_sha256 === null || typeof value.preimage_sha256 === "string" && SHA256.test(value.preimage_sha256))) return false;
  if (!(value.postimage_sha256 === null || typeof value.postimage_sha256 === "string" && SHA256.test(value.postimage_sha256))) return false;
  if (!(value.postimage_base64 === null || typeof value.postimage_base64 === "string" && value.postimage_base64.length <= 350_000)) return false;

  if (value.kind === "create_file" && value.preimage_sha256 !== null) return false;
  if (value.kind !== "create_file" && value.preimage_sha256 === null) return false;
  if (value.kind === "delete_file") return value.postimage_base64 === null && value.postimage_sha256 === null;
  if (typeof value.postimage_base64 !== "string" || typeof value.postimage_sha256 !== "string") return false;
  const bytes = Buffer.from(value.postimage_base64, "base64");
  return bytes.byteLength <= MAX_REPAIR_PAYLOAD_BYTES
    && bytes.toString("base64") === value.postimage_base64
    && crypto.createHash("sha256").update(bytes).digest("hex") === value.postimage_sha256;
}

export function parseAgentJson(output: unknown): unknown {
  if (typeof output === "string") { try { return JSON.parse(output) as unknown; } catch { throw new ExecutionError("AGENT_OUTPUT_INVALID", "Agent output was not valid JSON."); } }
  return output;
}

export function validateAssessment(output: unknown): AgentAssessment {
  const value = parseAgentJson(output);
  if (!record(value) || !exactKeys(value, ["status", "summary", "repository_observations", "bundle_conflicts", "missing_prerequisites", "human_action"]) || !["COMPATIBLE", "REPLAN_REQUIRED", "HUMAN_REQUIRED", "BLOCKED"].includes(String(value.status)) || typeof value.summary !== "string" || value.summary.length > 16_384 || !stringArray(value.repository_observations) || !Array.isArray(value.bundle_conflicts) || value.bundle_conflicts.length > 256 || !stringArray(value.missing_prerequisites) || !(value.human_action === null || record(value.human_action))) throw new ExecutionError("AGENT_OUTPUT_INVALID", "Invalid Terra assessment output.");
  for (const conflict of value.bundle_conflicts) if (!record(conflict) || !exactKeys(conflict, ["id", "severity", "description", "affected_contract"]) || typeof conflict.id !== "string" || conflict.id.length > 256 || !["low", "medium", "high", "critical"].includes(String(conflict.severity)) || typeof conflict.description !== "string" || conflict.description.length > 16_384 || typeof conflict.affected_contract !== "string" || conflict.affected_contract.length > 512) throw new ExecutionError("AGENT_OUTPUT_INVALID", "Invalid Terra assessment conflict.");
  if (value.human_action !== null && (!exactKeys(value.human_action, ["category", "description", "requested_capability"]) || !["credential", "network", "destructive", "production", "ambiguous_requirement", "paid_resource", "other"].includes(String(value.human_action.category)) || typeof value.human_action.description !== "string" || value.human_action.description.length > 16_384 || typeof value.human_action.requested_capability !== "string" || value.human_action.requested_capability.length > 4_096)) throw new ExecutionError("AGENT_OUTPUT_INVALID", "Invalid human action.");
  return value as unknown as AgentAssessment;
}

export function validateImplementation(output: unknown): AgentImplementationResult {
  const value = parseAgentJson(output);
  if (!record(value) || !exactKeys(value, ["status", "summary", "changed_files_claimed", "acceptance_evidence", "tests_added_or_changed", "unresolved_issues", "human_action"]) || !["READY_FOR_VERIFICATION", "REPLAN_REQUIRED", "HUMAN_REQUIRED", "BLOCKED"].includes(String(value.status)) || typeof value.summary !== "string" || value.summary.length > 16_384 || !stringArray(value.changed_files_claimed, 256, 512) || value.changed_files_claimed.some((entry) => !safeRelative(entry)) || !Array.isArray(value.acceptance_evidence) || value.acceptance_evidence.length > 256 || !stringArray(value.tests_added_or_changed, 256, 512) || value.tests_added_or_changed.some((entry) => !safeRelative(entry)) || !stringArray(value.unresolved_issues) || !(value.human_action === null || record(value.human_action))) throw new ExecutionError("AGENT_OUTPUT_INVALID", "Invalid Terra implementation output.");
  for (const item of value.acceptance_evidence) if (!record(item) || !exactKeys(item, ["acceptance_id", "status", "evidence", "notes"]) || typeof item.acceptance_id !== "string" || item.acceptance_id.length > 256 || !["implemented", "partially_implemented", "blocked"].includes(String(item.status)) || !stringArray(item.evidence, 64, 4_096) || item.evidence.some((entry) => !safeEvidence(entry)) || typeof item.notes !== "string" || item.notes.length > 16_384) throw new ExecutionError("AGENT_OUTPUT_INVALID", "Invalid acceptance evidence entry.");
  if (value.human_action !== null && (!exactKeys(value.human_action, ["category", "description", "requested_capability"]) || !["credential", "network", "destructive", "production", "ambiguous_requirement", "paid_resource", "other"].includes(String(value.human_action.category)) || typeof value.human_action.description !== "string" || typeof value.human_action.requested_capability !== "string")) throw new ExecutionError("AGENT_OUTPUT_INVALID", "Invalid human action.");
  return value as unknown as AgentImplementationResult;
}

function finding(value: unknown): value is ReviewFinding {
  return record(value) && exactKeys(value, ["id", "severity", "category", "file", "line_start", "line_end", "acceptance_ids", "problem", "evidence", "required_fix"]) && typeof value.id === "string" && value.id.length <= 256 && ["medium", "high", "critical"].includes(String(value.severity)) && ["correctness", "security", "regression", "scope", "tests", "maintainability", "performance"].includes(String(value.category)) && typeof value.file === "string" && safeRelative(value.file) && Number.isInteger(value.line_start) && Number.isInteger(value.line_end) && stringArray(value.acceptance_ids, 64, 256) && typeof value.problem === "string" && value.problem.length <= 16_384 && typeof value.evidence === "string" && value.evidence.length <= 16_384 && typeof value.required_fix === "string" && value.required_fix.length <= 16_384;
}

export function validateReview(output: unknown): ReviewResult {
  const value = parseAgentJson(output);
  if (!record(value) || !exactKeys(value, ["verdict", "reviewed_change_set_sha256", "summary", "acceptance_results", "blocking_findings", "non_blocking_findings", "scope_violations", "unverified_acceptance", "human_action", "repair_operations"]) || !["APPROVE", "REVISE", "REPLAN", "ESCALATE"].includes(String(value.verdict)) || typeof value.reviewed_change_set_sha256 !== "string" || !SHA256.test(value.reviewed_change_set_sha256) || typeof value.summary !== "string" || value.summary.length > 16_384 || !Array.isArray(value.acceptance_results) || value.acceptance_results.length > 512 || !Array.isArray(value.blocking_findings) || value.blocking_findings.length > 256 || !value.blocking_findings.every(finding) || !Array.isArray(value.non_blocking_findings) || value.non_blocking_findings.length > 256 || !value.non_blocking_findings.every(finding) || !stringArray(value.scope_violations) || !stringArray(value.unverified_acceptance) || !(value.human_action === null || record(value.human_action))) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Invalid reviewer output.");
  if (value.human_action !== null && (!exactKeys(value.human_action, ["category", "description", "requested_capability"]) || !["credential", "network", "destructive", "production", "ambiguous_requirement", "paid_resource", "other"].includes(String(value.human_action.category)) || typeof value.human_action.description !== "string" || typeof value.human_action.requested_capability !== "string")) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Invalid reviewer human action.");
  const acceptanceIds = new Set<string>();
  for (const item of value.acceptance_results) if (!record(item) || !exactKeys(item, ["acceptance_id", "status", "evidence"]) || typeof item.acceptance_id !== "string" || item.acceptance_id.length > 256 || acceptanceIds.has(item.acceptance_id) || !["PASS", "FAIL", "UNVERIFIED"].includes(String(item.status)) || !stringArray(item.evidence, 64, 4_096)) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Invalid acceptance result."); else acceptanceIds.add(item.acceptance_id);

  const operationsValue = value.repair_operations ?? [];
  if (!Array.isArray(operationsValue) || operationsValue.length > MAX_REPAIR_OPERATIONS || !operationsValue.every(validateRepairOperation)) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Reviewer repair operations are invalid or exceed bounded authority.");
  const operations = operationsValue as ReviewerRepairOperation[];
  const ids = new Set<string>(); const paths = new Set<string>(); let totalPayload = 0;
  for (const operation of operations) {
    if (ids.has(operation.op_id) || paths.has(operation.path)) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Reviewer repair operations contain duplicate ids or paths.");
    ids.add(operation.op_id); paths.add(operation.path);
    if (operation.postimage_base64 !== null) totalPayload += Buffer.from(operation.postimage_base64, "base64").byteLength;
  }
  if (totalPayload > MAX_REPAIR_PAYLOAD_BYTES) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Reviewer repair payload exceeds the total adaptive-repair byte budget.");
  // A review-only legacy caller may return REVISE without mutation authority.
  // Harness-first adaptive review tightens this at its trust boundary by
  // requiring a non-empty bounded proposal before it will apply a repair.
  if (value.verdict !== "REVISE" && operations.length !== 0) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Only REVISE may carry repair operations.");
  return { ...(value as unknown as ReviewResult), repair_operations: operations };
}

export async function validateReviewFindings(review: ReviewResult, worktreePath: string, code: "TERRA_REVIEW_OUTPUT_INVALID" | "REVIEW_OUTPUT_INVALID" = "REVIEW_OUTPUT_INVALID", deletedPaths: readonly string[] = []): Promise<void> {
  try {
    await assertSeniorReviewFindingLocations(review, worktreePath, deletedPaths);
  } catch (error) {
    throw new ExecutionError(code, error instanceof Error ? error.message : "Review finding location is invalid.");
  }
}
