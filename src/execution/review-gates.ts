import type { ExecutionReceipt, ReviewResult } from "./contracts.js";
import { ExecutionError } from "./errors.js";

function approvalValid(review: ReviewResult | null, digest: string, requiredAcceptanceIds: string[] = []): boolean {
  if (!review || review.verdict !== "APPROVE" || review.reviewed_change_set_sha256 !== digest) return false;
  if (review.blocking_findings.length > 0 || review.scope_violations.length > 0 || review.unverified_acceptance.length > 0) return false;
  const results = new Map(review.acceptance_results.map((item) => [item.acceptance_id, item.status]));
  return requiredAcceptanceIds.every((id) => results.get(id) === "PASS");
}

export function assertTerraCanStart(receipt: ExecutionReceipt, terraReview: ReviewResult | null = null, requiredAcceptanceIds: string[] = []): void {
  if (!receipt.verification.required_commands_passed || receipt.verification.verified_change_set_sha256 !== receipt.change_set_sha256) throw new ExecutionError("TERRA_REVIEW_REQUIRED", "Deterministic verification must pass for the current digest before Terra review.");
  if (receipt.internal_reviewer.latest_thread_id && receipt.internal_reviewer.latest_thread_id === receipt.implementer.thread_id) throw new ExecutionError("TERRA_REVIEW_REQUIRED", "Terra reviewer must use an independent thread.");
  if (terraReview !== null && !approvalValid(terraReview, receipt.change_set_sha256 ?? "", requiredAcceptanceIds)) throw new ExecutionError("TERRA_REVIEW_REQUIRED", "Terra APPROVE is invalid for the current digest or acceptance set.");
}

export function assertSolCanStart(receipt: ExecutionReceipt, terraReview: ReviewResult | null, requiredAcceptanceIds: string[] = []): void {
  if (!receipt.verification.required_commands_passed || receipt.verification.verified_change_set_sha256 !== receipt.change_set_sha256) throw new ExecutionError("SOL_REVIEW_NOT_ALLOWED", "Sol review requires verifier PASS for the current digest.");
  if (!approvalValid(terraReview, receipt.change_set_sha256 ?? "", requiredAcceptanceIds)) throw new ExecutionError("SOL_REVIEW_NOT_ALLOWED", "Sol review requires a current Terra APPROVE.");
  if (!receipt.internal_reviewer.latest_thread_id || receipt.internal_reviewer.latest_thread_id === receipt.implementer.thread_id) throw new ExecutionError("SOL_REVIEW_NOT_ALLOWED", "Terra review must use an independent thread.");
  if (receipt.final_reviewer.latest_thread_id && (receipt.final_reviewer.latest_thread_id === receipt.implementer.thread_id || (receipt.internal_reviewer.thread_ids ?? [receipt.internal_reviewer.latest_thread_id]).includes(receipt.final_reviewer.latest_thread_id))) throw new ExecutionError("SOL_REVIEW_NOT_ALLOWED", "Sol review must use a thread independent of Terra.");
}

export function assertReadyForPublish(receipt: ExecutionReceipt, terraReview: ReviewResult | null, solReview: ReviewResult | null, requiredAcceptanceIds: string[] = []): void {
  const digest = receipt.change_set_sha256;
  if (!digest || receipt.verification.verified_change_set_sha256 !== digest || !receipt.verification.required_commands_passed) throw new ExecutionError("VERIFICATION_FAILED", "Required verification is not passing for the final digest.");
  if (!approvalValid(terraReview, digest, requiredAcceptanceIds)) throw new ExecutionError("TERRA_REVIEW_REQUIRED", "Terra has not approved the final digest.");
  if (!approvalValid(solReview, digest, requiredAcceptanceIds)) throw new ExecutionError("SOL_REVIEW_NOT_ALLOWED", "Sol has not approved the final digest.");
  const terraThreads = receipt.internal_reviewer.thread_ids ?? (receipt.internal_reviewer.latest_thread_id ? [receipt.internal_reviewer.latest_thread_id] : []);
  const solThreads = receipt.final_reviewer.thread_ids ?? (receipt.final_reviewer.latest_thread_id ? [receipt.final_reviewer.latest_thread_id] : []);
  if (!receipt.internal_reviewer.latest_thread_id || !receipt.final_reviewer.latest_thread_id || receipt.internal_reviewer.latest_thread_id === receipt.implementer.thread_id || receipt.final_reviewer.latest_thread_id === receipt.implementer.thread_id || solThreads.some((thread) => terraThreads.includes(thread))) throw new ExecutionError("SOL_REVIEW_NOT_ALLOWED", "Reviewers must use independent threads.");
}

export function invalidateReviews(receipt: ExecutionReceipt): void {
  receipt.internal_reviewer.verdict = null; receipt.internal_reviewer.reviewed_change_set_sha256 = null;
  receipt.final_reviewer.verdict = null; receipt.final_reviewer.reviewed_change_set_sha256 = null;
  receipt.verification.required_commands_passed = false; receipt.verification.verified_change_set_sha256 = null;
}
