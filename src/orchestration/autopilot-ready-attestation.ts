import { submitWebVerdict, getWebReviewStatus } from "../web-review/web-review-service.js";
import { resolveReviewRoundPaths } from "../web-review/web-review-paths.js";
import type { WebReviewReceipt } from "../web-review/contracts.js";
import { OrchestrationError } from "./contracts.js";

function assertMergeReady(runId: string, receipt: WebReviewReceipt): void {
  if (
    receipt.run_id !== runId ||
    receipt.state !== "APPROVED" ||
    receipt.action !== "ASK_USER_TO_MERGE" ||
    !Number.isInteger(receipt.review_round) ||
    receipt.review_round < 1 ||
    receipt.review_round > 4 ||
    !receipt.verdict_sha256 ||
    !receipt.decision_event_sha256 ||
    !receipt.fresh_attested_head_sha ||
    receipt.fresh_attested_head_sha !== receipt.published_commit_sha ||
    receipt.observed_head_sha !== receipt.published_commit_sha ||
    !receipt.completed_at
  ) {
    throw new OrchestrationError(
      "AUTOPILOT_READY_ATTESTATION_INVALID",
      "The latest Web review is not an exact approved merge-ready decision bound to the published Draft PR head.",
    );
  }
}

/**
 * Replays the already-sealed Web verdict through Phase 7's idempotent path.
 * Phase 7 deliberately performs a fresh read-only GitHub attestation even for
 * a terminal replay, so a moved/closed/non-draft PR can never inherit stale
 * READY_FOR_YOU authority from autopilot.json.
 */
export async function revalidateAutopilotReadyForMerge(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  now?: () => Date;
}): Promise<WebReviewReceipt> {
  const stored = await getWebReviewStatus({ runId: options.runId, stateDirectory: options.stateDirectory });
  if (!stored) {
    throw new OrchestrationError("AUTOPILOT_READY_ATTESTATION_INVALID", "No terminal Web review exists for the completed AUTOPILOT run.");
  }
  assertMergeReady(options.runId, stored);

  const paths = resolveReviewRoundPaths(options.stateDirectory, options.runId, stored.review_round);
  const refreshed = await submitWebVerdict({
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    verdictPath: paths.verdictPath,
    ...(options.now ? { now: options.now } : {}),
  });
  assertMergeReady(options.runId, refreshed);
  return refreshed;
}
