import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionError } from "../execution/errors.js";
import type { ReviewResult } from "../execution/contracts.js";

export const SENIOR_DIFF_REVIEW_INSTRUCTION = [
  "Act as a senior maintainer performing an adversarial pull-request review, not as a test-result summarizer.",
  "Deterministic verification passing is a prerequisite for review, not proof that the change is correct or complete.",
  "Inspect the complete diff against the supplied base commit in the read-only workspace. Treat any bounded diff embedded in the prompt as a navigation aid that may be truncated, never as the complete review surface.",
  "Review every changed file and every diff hunk before APPROVE. Inspect surrounding code, callers, state transitions, tests, and repository conventions whenever a hunk cannot be judged safely in isolation.",
  "Actively try to break the change across correctness and error paths; security and authority boundaries; concurrency, races, retries, replay and idempotency; crash/restart recovery and stale state; compatibility and regressions; data integrity; performance and resource use; test quality and missing negative cases; scope and maintainability.",
  "Do not trust implementation claims, reviewer summaries, or a green test suite as correctness evidence by themselves. Derive findings from the exact code, diff, frozen contract, and deterministic evidence.",
  "A blocking finding must describe a concrete failure mode or violated invariant, cite the exact file and line range, explain why existing verification does not rule it out, and state the minimum required fix. Do not invent speculative blockers.",
  "Keep style preferences and harmless cleanup as non-blocking findings. Medium, high, or critical correctness, security, regression, scope, tests, maintainability, or performance defects may block when they can affect behavior, safety, recovery, or long-term architecture.",
  "APPROVE only after the complete diff has been inspected, every required acceptance criterion is PASS, there is no scope violation or unverified required behavior, and no blocking finding remains.",
  "Use REVISE for a bounded fix inside the frozen contract. When exact safe repair authority can be expressed, include the complete bounded repair_operations in the same response so Harness can apply and re-verify it without another reviewer call.",
  "Use REPLAN when the frozen contract or architecture is insufficient for a correct bounded fix. Use ESCALATE when a consequential product, credential, production, destructive, paid-resource, or unresolved human decision is required.",
  "If the complete diff cannot be inspected with the available read-only evidence/tools, do not APPROVE. Fail closed with the verdict appropriate to the missing authority/context.",
  "Never modify files, never request approval to mutate the workspace, and return only the required reviewer JSON.",
].join("\n");

/**
 * Model output is probabilistic; lifecycle authority is not. Reject verdicts
 * whose structured evidence contradicts the claimed decision before any
 * executor can treat the review as approval authority.
 */
export function assertSeniorReviewConsistency(review: ReviewResult): void {
  const repairCount = review.repair_operations?.length ?? 0;
  if (review.verdict === "APPROVE") {
    if (review.blocking_findings.length > 0) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "APPROVE cannot carry blocking findings.");
    if (review.scope_violations.length > 0) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "APPROVE cannot carry scope violations.");
    if (review.unverified_acceptance.length > 0 || review.acceptance_results.some((result) => result.status !== "PASS")) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "APPROVE requires all reported acceptance evidence to be PASS and fully verified.");
    if (review.human_action !== null) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "APPROVE cannot require a human action.");
    if (repairCount !== 0) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "APPROVE cannot carry repair operations.");
    return;
  }

  if (review.verdict === "REVISE") {
    if (review.blocking_findings.length === 0) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "REVISE requires at least one concrete blocking finding.");
    if (review.human_action !== null) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "REVISE cannot simultaneously require a human action; use ESCALATE instead.");
  }
}

/**
 * Re-attest reviewer citations against the exact read-only worktree. A missing
 * path is accepted only when it is part of the exact changed-path set: in a
 * stable post-change worktree that is the representation needed for a deleted
 * or renamed-away diff hunk. Existing files must be regular, non-symlink files
 * and the reported line range must exist.
 */
export async function assertSeniorReviewFindingLocations(review: ReviewResult, workspacePath: string, changedPaths: readonly string[] = []): Promise<void> {
  const root = path.resolve(workspacePath);
  const rootPrefix = `${root}${path.sep}`;
  const changed = new Set(changedPaths);

  for (const finding of [...review.blocking_findings, ...review.non_blocking_findings]) {
    const target = path.resolve(root, finding.file);
    if (!target.startsWith(rootPrefix) && target !== root) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Review finding path escapes the worktree.");
    if (!Number.isInteger(finding.line_start) || !Number.isInteger(finding.line_end) || finding.line_start < 1 || finding.line_end < finding.line_start) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Review finding line range is invalid.");

    const info = await lstat(target).catch(() => undefined);
    if (!info) {
      if (changed.has(finding.file)) continue;
      throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Review finding points to a file that does not exist and is not an exact changed/deleted path.");
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Review finding must point to a regular non-symlink file.");

    let source: string;
    try { source = await readFile(target, "utf8"); }
    catch { throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Review finding file could not be read safely."); }
    const lineCount = Math.max(1, source.split(/\r?\n/).length);
    if (finding.line_end > lineCount) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Review finding line range is outside the reviewed file.");
  }
}
