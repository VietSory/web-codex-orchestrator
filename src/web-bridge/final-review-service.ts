import { readExecutorReceipt } from "../executor/store.js";
import { readSelectedArtifact } from "../orchestration/artifact-binding.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { contentDigest, WebBridgeError, type BridgeJobIdentity } from "./contracts.js";
import type { WebBridge } from "./web-bridge.js";
import { loadAndVerifyResultBundle } from "../web-review/result-bundle-review-reader.js";
import { readBoundedResultEvidence } from "./result-evidence-reader.js";
import { assertCodeReviewApprovedForCurrentResult, createPendingCodeReview, readWebCodeReviewReceipt, type WebCodeReviewReceipt } from "./code-review-service.js";

export type WebReviewPurpose = "independent_code_review" | "final_intent_review";
export type PendingWebReview = BridgeJobIdentity & { purpose: WebReviewPurpose };

async function codeReviewBindsCanonicalResult(stateDirectory: string, runId: string, review: WebCodeReviewReceipt): Promise<boolean> {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split), archiveSha = runId.slice(split + 1);
  const result = await readResultBundleReceipt(resultBundlePaths(stateDirectory, taskId, archiveSha).receiptPath);
  return Boolean(
    result && result.state === "READY_FOR_WEB_REVIEW" && result.archive_sha256 &&
    review.run_id === result.run_id && review.result_bundle_sha256 === result.archive_sha256 &&
    review.published_commit_sha === result.published_commit_sha &&
    review.pull_request_number === result.pull_request.number,
  );
}

async function pairCodeReviewGate(options: { bridge: WebBridge; runId: string; stateDirectory: string }): Promise<BridgeJobIdentity | null> {
  const split = options.runId.lastIndexOf(":");
  const taskId = options.runId.slice(0, split), archiveSha = options.runId.slice(split + 1);
  const selected = await readSelectedArtifact(options.stateDirectory, options.runId);
  if (!selected) return null;
  const executor = await readExecutorReceipt(options.stateDirectory, taskId, archiveSha, selected.artifact_sha256);
  if (executor?.review_strategy !== "web") return null;

  const review = await readWebCodeReviewReceipt(options.stateDirectory, options.runId);
  if (review?.state === "APPROVED") {
    try {
      await assertCodeReviewApprovedForCurrentResult(options.stateDirectory, options.runId);
      return null;
    } catch (error) {
      if (!(error instanceof WebBridgeError) || error.code !== "WEB_CODE_REVIEW_STALE") throw error;
      return await createPendingCodeReview(options);
    }
  }
  if (review?.state === "REVISION_REQUESTED") {
    if (await codeReviewBindsCanonicalResult(options.stateDirectory, options.runId, review)) {
      throw new WebBridgeError("WEB_CODE_REVIEW_REVISION_REQUIRED", "Independent Web code review requested a bounded repair before final intent review can start.");
    }
    // The old REVISE authority belongs to a previous exact Result generation.
    // After Harness repair + same-PR republish, require a fresh independent
    // code-review job instead of treating the old terminal state as current.
    return await createPendingCodeReview(options);
  }
  if (review?.state === "ESCALATED") throw new WebBridgeError("WEB_CODE_REVIEW_ESCALATED", "Independent Web code review escalated a consequential decision before final intent review.");
  return await createPendingCodeReview(options);
}

/**
 * Create the next Web review required by policy and return its explicit role.
 * Callers must never infer that every pending review is the original-Web final
 * review: PAIR may first require an independent code-review job.
 */
export async function createPendingFinalReview(options: { bridge: WebBridge; runId: string; stateDirectory: string }): Promise<PendingWebReview> {
  const split = options.runId.lastIndexOf(":");
  const taskId = options.runId.slice(0, split), archiveSha = options.runId.slice(split + 1);
  if (split < 1 || !/^[a-f0-9]{64}$/.test(archiveSha)) throw new WebBridgeError("WEB_FINAL_REVIEW_RUN_INVALID", "Run identity is invalid.");

  const codeReviewJob = await pairCodeReviewGate(options);
  if (codeReviewJob) return { ...codeReviewJob, purpose: "independent_code_review" };

  const receipt = await readResultBundleReceipt(resultBundlePaths(options.stateDirectory, taskId, archiveSha).receiptPath);
  if (!receipt || receipt.state !== "READY_FOR_WEB_REVIEW" || !receipt.archive_sha256) throw new WebBridgeError("WEB_FINAL_REVIEW_NOT_READY", "Result Bundle is not ready; no review job was created.");
  const reviewRound = receipt.result_bundle_version === "1.2" ? (receipt.revision_round ?? 1) + 1 : 1;
  const request = { run_id: options.runId, result_bundle_sha256: receipt.archive_sha256, published_commit_sha: receipt.published_commit_sha, pull_request_url: receipt.pull_request.url, review_round: reviewRound };
  const identity = await options.bridge.createFinalReviewJob(request, `final-review-${contentDigest({ purpose: "final_intent_review", request })}`);
  const verified = await loadAndVerifyResultBundle(options.stateDirectory, options.runId, reviewRound);
  const evidence = await readBoundedResultEvidence(verified.archivePath, verified.manifest);
  await options.bridge.submitFinalReviewEvidence(identity.job_id, { purpose: "final_intent_review", binding: request, entries: evidence }, `final-evidence-${receipt.archive_sha256}`);
  return { ...identity, purpose: "final_intent_review" };
}