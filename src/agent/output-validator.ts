import { ExecutionError } from "../execution/errors.js";
import type { AgentAssessment, AgentImplementationResult, ReviewFinding, ReviewResult } from "../execution/contracts.js";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function stringArray(value: unknown, maximum = 256, maximumLength = 4_096): value is string[] { return Array.isArray(value) && value.length <= maximum && value.every((entry) => typeof entry === "string" && entry.length <= maximumLength); }
function safeRelative(value: string): boolean { return value.length > 0 && value.length <= 512 && !value.includes("\u0000") && !value.includes("\\") && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split("/").includes(".."); }
function safeEvidence(value: string): boolean {
  if (value.includes("\u0000") || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const location = value.split(/[:#]/, 1)[0]?.trim() ?? "";
  return !location.split("/").includes("..");
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
  if (!record(value) || !exactKeys(value, ["verdict", "reviewed_change_set_sha256", "summary", "acceptance_results", "blocking_findings", "non_blocking_findings", "scope_violations", "unverified_acceptance", "human_action"]) || !["APPROVE", "REVISE", "REPLAN", "ESCALATE"].includes(String(value.verdict)) || typeof value.reviewed_change_set_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.reviewed_change_set_sha256) || typeof value.summary !== "string" || value.summary.length > 16_384 || !Array.isArray(value.acceptance_results) || value.acceptance_results.length > 512 || !Array.isArray(value.blocking_findings) || value.blocking_findings.length > 256 || !value.blocking_findings.every(finding) || !Array.isArray(value.non_blocking_findings) || value.non_blocking_findings.length > 256 || !value.non_blocking_findings.every(finding) || !stringArray(value.scope_violations) || !stringArray(value.unverified_acceptance) || !(value.human_action === null || record(value.human_action))) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Invalid reviewer output.");
  if (value.human_action !== null && (!exactKeys(value.human_action, ["category", "description", "requested_capability"]) || !["credential", "network", "destructive", "production", "ambiguous_requirement", "paid_resource", "other"].includes(String(value.human_action.category)) || typeof value.human_action.description !== "string" || typeof value.human_action.requested_capability !== "string")) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Invalid reviewer human action.");
  const acceptanceIds = new Set<string>();
  for (const item of value.acceptance_results) if (!record(item) || !exactKeys(item, ["acceptance_id", "status", "evidence"]) || typeof item.acceptance_id !== "string" || item.acceptance_id.length > 256 || acceptanceIds.has(item.acceptance_id) || !["PASS", "FAIL", "UNVERIFIED"].includes(String(item.status)) || !stringArray(item.evidence, 64, 4_096)) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Invalid acceptance result."); else acceptanceIds.add(item.acceptance_id);
  return value as unknown as ReviewResult;
}

export async function validateReviewFindings(review: ReviewResult, worktreePath: string, code: "TERRA_REVIEW_OUTPUT_INVALID" | "REVIEW_OUTPUT_INVALID" = "REVIEW_OUTPUT_INVALID"): Promise<void> {
  for (const finding of [...review.blocking_findings, ...review.non_blocking_findings]) {
    if (!finding.file || path.posix.isAbsolute(finding.file) || finding.file.split("/").includes("..") || finding.file.includes("\\")) throw new ExecutionError(code, "Review finding path is unsafe.");
    const target = path.resolve(worktreePath, finding.file); const root = `${path.resolve(worktreePath)}${path.sep}`;
    if (!target.startsWith(root) && target !== path.resolve(worktreePath)) throw new ExecutionError(code, "Review finding path escapes the worktree.");
    const info = await lstat(target).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isFile()) throw new ExecutionError(code, "Review finding points to a file that does not exist.");
    let source: string;
    try { source = await readFile(target, "utf8"); } catch { throw new ExecutionError(code, "Review finding file could not be read safely."); }
    const lines = source.split(/\r?\n/).length;
    if (!Number.isInteger(finding.line_start) || !Number.isInteger(finding.line_end) || finding.line_start < 1 || finding.line_end < finding.line_start || finding.line_end > Math.max(1, lines)) throw new ExecutionError(code, "Review finding line range is invalid.");
  }
}
