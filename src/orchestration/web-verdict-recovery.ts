import { getWebReviewStatus } from "../web-review/web-review-service.js";
import type { WebReviewReceipt } from "../web-review/contracts.js";
import { completeAttempt } from "./controller.js";
import { sealTransitionRequest } from "./retry-policy.js";
import type { RunLedger, TransitionKind } from "./contracts.js";

const TERMINAL = new Set(["APPROVED", "REVISION_REQUESTED", "ESCALATED"]);

function nextTransition(receipt: WebReviewReceipt): TransitionKind {
  return receipt.state === "REVISION_REQUESTED" ? "REVISE" : "WAIT_HUMAN";
}

export interface WebVerdictRecoveryDependencies {
  getStatus: typeof getWebReviewStatus;
  completeAttempt: typeof completeAttempt;
}

const productionDependencies: WebVerdictRecoveryDependencies = {
  getStatus: getWebReviewStatus,
  completeAttempt,
};

export async function recoverCompletedWebVerdictAttempt(options: {
  stateDirectory: string;
  runId: string;
  ledger: RunLedger;
  dependencies?: Partial<WebVerdictRecoveryDependencies>;
  now?: () => Date;
}): Promise<RunLedger> {
  const attempt = options.ledger.current_attempt;
  if (!attempt || attempt.status !== "STARTED" || attempt.transition !== "WAIT_WEB_VERDICT") return options.ledger;
  const deps = { ...productionDependencies, ...options.dependencies };
  const now = options.now ?? (() => new Date());

  for (let round = 1; round <= 4; round += 1) {
    const receipt = await deps.getStatus({ runId: options.runId, stateDirectory: options.stateDirectory, round });
    if (!receipt || !TERMINAL.has(receipt.state) || !receipt.verdict_sha256 || !receipt.completed_at) continue;
    if (Date.parse(receipt.completed_at) < Date.parse(attempt.started_at)) continue;
    const sealed = sealTransitionRequest("WAIT_WEB_VERDICT", {
      verdict_sha256: receipt.verdict_sha256,
      review_round: receipt.review_round,
    });
    if (sealed !== attempt.request_sha256) continue;
    return await deps.completeAttempt({
      stateDirectory: options.stateDirectory,
      runId: options.runId,
      attemptId: attempt.attempt_id,
      result: {
        state: receipt.state,
        review_round: receipt.review_round,
        verdict_sha256: receipt.verdict_sha256,
        result_bundle_sha256: receipt.result_bundle_sha256,
        published_commit_sha: receipt.published_commit_sha,
        fresh_attested_head_sha: receipt.fresh_attested_head_sha,
        adopted_after_restart: true,
      },
      nextTransition: nextTransition(receipt),
      now: now(),
    });
  }
  return options.ledger;
}
