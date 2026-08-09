import crypto from "node:crypto";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { readExecutorReceipt } from "../executor/store.js";
import { executorPaths } from "../executor/paths.js";
import type { ExecutorReceipt } from "../executor/contracts.js";
import { readGitPublishReceiptSnapshot, type GitPublishReceiptSnapshot } from "../publish/publish-store.js";
import { readDraftPullRequestReceiptSnapshot, type DraftPullRequestReceiptSnapshot } from "../pull-request/draft-pr-store.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import type { ResultBundleReceipt } from "../result-bundle/contracts.js";
import type { RevisionReceipt } from "../revision/contracts.js";
import { getRevisionStatus } from "../revision/revision-service.js";
import type { WebReviewReceipt } from "../web-review/contracts.js";
import { getWebReviewStatus } from "../web-review/web-review-service.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import type { LifecycleSnapshot } from "./planner.js";
import { OrchestrationError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id for lifecycle snapshot.");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function executorReceiptSha256(receipt: ExecutorReceipt): string {
  return sha256(canonicalJsonBuffer(receipt));
}

/**
 * Phase 13 result readiness is an exact selected-artifact binding, not merely a
 * run-level READY flag. A handoff produced for an older selected artifact,
 * exact Phase 5 receipt, publish head, or Draft PR must never make the planner
 * quiescent.
 */
export function initialResultBoundToSelectedExecutor(
  runId: string,
  executor: ExecutorReceipt | null,
  publishSnapshot: GitPublishReceiptSnapshot | null,
  draftSnapshot: DraftPullRequestReceiptSnapshot | null,
  result: ResultBundleReceipt | null,
): boolean {
  const publish = publishSnapshot?.receipt ?? null;
  const draft = draftSnapshot?.receipt ?? null;
  if (
    !executor || executor.run_id !== runId || executor.state !== "READY_FOR_PUBLISH" || executor.change_set_digest === null ||
    !publishSnapshot || !publish || publish.run_id !== runId || publish.state !== "PUSHED" || publish.commit_sha === null || publish.remote_branch_sha !== publish.commit_sha ||
    !draftSnapshot || !draft || draft.run_id !== runId || draft.state !== "OPEN" || draft.pull_number === null || draft.expected_head_sha !== publish.commit_sha ||
    !result || result.run_id !== runId || result.state !== "READY_FOR_WEB_REVIEW" || result.archive_sha256 === null
  ) return false;

  return result.execution_receipt_sha256 === executorReceiptSha256(executor)
    && result.git_publish_receipt_sha256 === sha256(publishSnapshot.bytes)
    && result.draft_pr_receipt_sha256 === sha256(draftSnapshot.bytes)
    && result.change_set_sha256 === executor.change_set_digest
    && result.base_commit === executor.base_commit
    && result.published_commit_sha === publish.commit_sha
    && result.remote_branch_sha === publish.commit_sha
    && result.pull_request.number === draft.pull_number
    && result.pull_request.state === "open"
    && result.pull_request.draft === true
    && result.pull_request.head_branch === draft.head_branch
    && result.pull_request.head_sha === publish.commit_sha
    && result.pull_request.base_branch === draft.base_branch;
}

export function revisionReceiptBoundToWebReview(runId: string, review: WebReviewReceipt | null, revision: RevisionReceipt | null): boolean {
  return review?.state === "REVISION_REQUESTED"
    && revision?.run_id === runId
    && revision.revision_round === review.review_round
    && revision.revision_request_sha256 === review.revision_request_sha256
    && revision.previous_verdict_sha256 === review.verdict_sha256
    && revision.previous_pr_head_sha === review.fresh_attested_head_sha
    && revision.pull_request_number === review.pull_request_number;
}

export function revisionResultReadyForWebReview(runId: string, review: WebReviewReceipt | null, revision: RevisionReceipt | null): boolean {
  return revisionReceiptBoundToWebReview(runId, review, revision)
    && revision?.state === "RESULT_READY"
    && revision.new_published_commit_sha !== null
    && revision.remote_branch_sha === revision.new_published_commit_sha
    && revision.result_bundle_sha256 !== null
    && revision.result_manifest_sha256 !== null
    && revision.next_review_round === revision.revision_round + 1;
}

export async function readLifecycleSnapshot(stateDirectory: string, runId: string): Promise<LifecycleSnapshot> {
  const selected = await readSelectedArtifact(stateDirectory, runId);
  if (!selected) return { registered_artifact_sha256: null, executor_state: null, publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_review_state: null, revision_state: null, revision_result_ready: false };
  const id = splitRunId(runId);
  const executor = await readExecutorReceipt(stateDirectory, id.taskId, id.taskBundleSha256, selected.artifact_sha256);
  const directory = executorPaths(stateDirectory, id.taskId, id.taskBundleSha256, selected.artifact_sha256).directory;
  const publishDirectory = path.join(directory, "publish");
  const resultPaths = resultBundlePaths(stateDirectory, id.taskId, id.taskBundleSha256);
  const [publishSnapshot, draftSnapshot, result, review, revision] = await Promise.all([
    readGitPublishReceiptSnapshot(path.join(publishDirectory, "git-publish.json")),
    readDraftPullRequestReceiptSnapshot(path.join(publishDirectory, "github-draft-pr.json")),
    readResultBundleReceipt(resultPaths.receiptPath),
    getWebReviewStatus({ runId, stateDirectory }),
    getRevisionStatus(stateDirectory, runId),
  ]);
  const publish = publishSnapshot?.receipt ?? null;
  const draft = draftSnapshot?.receipt ?? null;
  const webReviewState = review?.state === "APPROVED" || review?.state === "REVISION_REQUESTED" || review?.state === "ESCALATED"
    ? review.state
    : review ? "PENDING" : null;
  const relevantRevision = revisionReceiptBoundToWebReview(runId, review, revision) ? revision : null;
  return {
    registered_artifact_sha256: selected.artifact_sha256,
    executor_state: executor?.state ?? null,
    publish_state: publish?.state ?? null,
    draft_pr_state: draft?.state ?? null,
    result_bundle_ready: initialResultBoundToSelectedExecutor(runId, executor, publishSnapshot, draftSnapshot, result),
    web_review_state: webReviewState,
    revision_state: relevantRevision?.state ?? null,
    revision_result_ready: revisionResultReadyForWebReview(runId, review, revision),
  };
}
