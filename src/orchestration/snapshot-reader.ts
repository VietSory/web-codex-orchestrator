import path from "node:path";
import { readExecutorReceipt } from "../executor/store.js";
import { executorPaths } from "../executor/paths.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { readDraftPullRequestReceipt } from "../pull-request/draft-pr-store.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { getWebReviewStatus } from "../web-review/web-review-service.js";
import { getRevisionStatus } from "../revision/revision-service.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import type { LifecycleSnapshot } from "./planner.js";
import { OrchestrationError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id for lifecycle snapshot.");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}

export async function readLifecycleSnapshot(stateDirectory: string, runId: string): Promise<LifecycleSnapshot> {
  const selected = await readSelectedArtifact(stateDirectory, runId);
  if (!selected) return { registered_artifact_sha256: null, executor_state: null, publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_review_state: null, revision_state: null, revision_result_ready: false };
  const id = splitRunId(runId);
  const executor = await readExecutorReceipt(stateDirectory, id.taskId, id.taskBundleSha256, selected.artifact_sha256);
  const directory = executorPaths(stateDirectory, id.taskId, id.taskBundleSha256, selected.artifact_sha256).directory;
  const publishDirectory = path.join(directory, "publish");
  const resultPaths = resultBundlePaths(stateDirectory, id.taskId, id.taskBundleSha256);
  const [publish, draft, result, review, revision] = await Promise.all([
    readGitPublishReceipt(path.join(publishDirectory, "git-publish.json")),
    readDraftPullRequestReceipt(path.join(publishDirectory, "github-draft-pr.json")),
    readResultBundleReceipt(resultPaths.receiptPath),
    getWebReviewStatus({ runId, stateDirectory }),
    getRevisionStatus(stateDirectory, runId),
  ]);
  const webReviewState = review?.state === "APPROVED" || review?.state === "REVISION_REQUESTED" || review?.state === "ESCALATED"
    ? review.state
    : review ? "PENDING" : null;
  const relevantRevision = review?.state === "REVISION_REQUESTED"
    && revision?.run_id === runId
    && revision.revision_round === review.review_round
    && revision.revision_request_sha256 === review.revision_request_sha256
    && revision.previous_verdict_sha256 === review.verdict_sha256
    && revision.previous_pr_head_sha === review.fresh_attested_head_sha
    && revision.pull_request_number === review.pull_request_number
    ? revision
    : null;
  const revisionResultReady = relevantRevision?.state === "RESULT_READY"
    && relevantRevision.new_published_commit_sha !== null
    && relevantRevision.remote_branch_sha === relevantRevision.new_published_commit_sha
    && relevantRevision.result_bundle_sha256 !== null
    && relevantRevision.result_manifest_sha256 !== null
    && relevantRevision.next_review_round === relevantRevision.revision_round + 1;
  return {
    registered_artifact_sha256: selected.artifact_sha256,
    executor_state: executor?.state ?? null,
    publish_state: publish?.state ?? null,
    draft_pr_state: draft?.state ?? null,
    result_bundle_ready: result?.state === "READY_FOR_WEB_REVIEW" && result.run_id === runId,
    web_review_state: webReviewState,
    revision_state: relevantRevision?.state ?? null,
    revision_result_ready: revisionResultReady,
  };
}
