import type { LifecycleSnapshot } from "../orchestration/planner.js";
import { formatUserStage, type UserStage } from "./stages.js";

export interface PairStatusView {
  goal: string;
  planLocked: boolean;
  snapshot: LifecycleSnapshot;
  draftPrUrl?: string | null;
}

function hasExecutorFailure(state: string | null): boolean {
  if (!state) return false;
  return state.includes("FAIL") || state.includes("ESCALATE");
}

function isExecutorVerifying(state: string | null): boolean {
  if (!state) return false;
  return state.includes("VERIFY");
}

export function derivePairStage(snapshot: LifecycleSnapshot): UserStage {
  if (hasExecutorFailure(snapshot.executor_state)) return "BLOCKED";
  if (!snapshot.registered_artifact_sha256) return "WEB_IMPLEMENTATION";
  if (snapshot.executor_state !== "READY_FOR_PUBLISH") {
    return isExecutorVerifying(snapshot.executor_state) ? "VERIFICATION" : "EXECUTION";
  }
  if (snapshot.publish_state !== "PUSHED") return "PUBLISHING";
  if (snapshot.draft_pr_state !== "OPEN") return "DRAFT_PR";
  if (!snapshot.result_bundle_ready) return "RESULT_BUNDLE";

  if (snapshot.web_code_review_state === "ESCALATED" || snapshot.web_code_review_state === "BLOCKED") return "BLOCKED";
  if (snapshot.web_code_review_state !== "APPROVED") return "TERRA_REVIEW";

  if (snapshot.web_review_state === "ESCALATED") return "BLOCKED";
  if (snapshot.web_review_state === "REVISION_REQUESTED") {
    return snapshot.revision_state === "RESULT_READY" && snapshot.revision_result_ready ? "WEB_FINAL_REVIEW" : "REVISION";
  }
  if (snapshot.web_review_state === "APPROVED") return "AWAITING_HUMAN";
  return "WEB_FINAL_REVIEW";
}

function checksLabel(snapshot: LifecycleSnapshot): string {
  if (snapshot.executor_state === "READY_FOR_PUBLISH") return "passed";
  if (hasExecutorFailure(snapshot.executor_state)) return "stopped safely";
  if (isExecutorVerifying(snapshot.executor_state)) return "running";
  return "not finished";
}

function codeReviewLabel(snapshot: LifecycleSnapshot): string {
  if (!snapshot.result_bundle_ready) return "not started";
  if (snapshot.web_code_review_state === "APPROVED") return "approved";
  if (snapshot.web_code_review_state === "ESCALATED" || snapshot.web_code_review_state === "BLOCKED") return "needs attention";
  return "in progress";
}

function draftPrLabel(snapshot: LifecycleSnapshot, url?: string | null): string {
  if (snapshot.draft_pr_state === "OPEN") return url ?? "ready";
  if (snapshot.publish_state === "PUSHED") return "being prepared";
  return "not created yet";
}

function finalReviewLabel(snapshot: LifecycleSnapshot): string {
  if (snapshot.web_code_review_state !== "APPROVED") return "not started";
  if (snapshot.web_review_state === "APPROVED") return "approved";
  if (snapshot.web_review_state === "ESCALATED") return "needs attention";
  if (snapshot.web_review_state === "REVISION_REQUESTED") return "revision requested";
  return "in progress";
}

function nextAction(stage: UserStage): string {
  switch (stage) {
    case "AWAITING_HUMAN": return "review the Draft PR and merge when ready";
    case "BLOCKED":
    case "FAILED": return "use /review for evidence and /doctor for recovery guidance";
    case "REVISION": return "WCO is applying the requested review fixes";
    case "WEB_FINAL_REVIEW": return "WCO is waiting for the final review";
    case "TERRA_REVIEW":
    case "SOL_REVIEW": return "WCO is reviewing the exact change";
    default: return "WCO can continue from saved progress with /run if it is not already running";
  }
}

export function formatPairStatus(view: PairStatusView): string {
  const stage = derivePairStage(view.snapshot);
  return [
    `PAIR · ${formatUserStage(stage)}`,
    `Goal          ${view.goal}`,
    `Plan          ${view.planLocked ? "locked" : "being refined"}`,
    `Checks        ${checksLabel(view.snapshot)}`,
    `Code review   ${codeReviewLabel(view.snapshot)}`,
    `Draft PR      ${draftPrLabel(view.snapshot, view.draftPrUrl)}`,
    `Final review  ${finalReviewLabel(view.snapshot)}`,
    `Next          ${nextAction(stage)}`,
  ].join("\n");
}

export function formatPairReview(options: {
  snapshot: LifecycleSnapshot;
  checksPassed: boolean;
  codeReview: string;
  draftPrUrl?: string | null;
  gitVerified: boolean;
}): string {
  const stage = derivePairStage(options.snapshot);
  return [
    `Review · ${formatUserStage(stage)}`,
    `Checks        ${options.checksPassed ? "passed" : "not complete"}`,
    `Code review   ${options.codeReview}`,
    `Final review  ${finalReviewLabel(options.snapshot)}`,
    `Git result    ${options.gitVerified ? "verified" : "not ready"}`,
    `Draft PR      ${draftPrLabel(options.snapshot, options.draftPrUrl)}`,
    `Next          ${nextAction(stage)}`,
  ].join("\n");
}
