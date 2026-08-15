import type { LifecycleSnapshot } from "../orchestration/planner.js";
import { formatUserStage, type UserStage } from "./stages.js";

export interface PairStatusView {
  goal: string;
  planLocked: boolean;
  snapshot: LifecycleSnapshot;
  draftPrUrl?: string | null;
}

function hasExecutorFailure(state: string | null): boolean {
  return state === "FAILED";
}

function isExecutorVerifying(state: string | null): boolean {
  return state === "VERIFYING";
}

function isExecutorRepairing(state: string | null): boolean {
  return state === "REPAIR_APPLYING" || state === "REPAIR_APPLIED";
}

export function derivePairStage(snapshot: LifecycleSnapshot): UserStage {
  if (hasExecutorFailure(snapshot.executor_state)) return "BLOCKED";
  if (!snapshot.registered_artifact_sha256 || snapshot.executor_state === "ESCALATE_TO_WEB") return "WEB_IMPLEMENTATION";
  if (isExecutorRepairing(snapshot.executor_state)) return "REVISION";
  if (snapshot.executor_state === "REVIEWING_WEB" || snapshot.executor_state === "REVIEWING_TERRA" || snapshot.executor_state === "REVIEWING_SOL") return "TERRA_REVIEW";
  if (snapshot.executor_state !== "READY_FOR_PUBLISH") {
    return isExecutorVerifying(snapshot.executor_state) ? "VERIFICATION" : "EXECUTION";
  }
  if (snapshot.publish_state !== "PUSHED") return "PUBLISHING";
  if (snapshot.draft_pr_state !== "OPEN") return "DRAFT_PR";
  if (!snapshot.result_bundle_ready) return "RESULT_BUNDLE";

  if (snapshot.web_code_review_state === "ESCALATED") return "BLOCKED";
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
  if (isExecutorRepairing(snapshot.executor_state)) return "will run again after fixes";
  return "not finished";
}

function codeReviewLabel(snapshot: LifecycleSnapshot): string {
  if (!snapshot.result_bundle_ready) return "not started";
  if (snapshot.web_code_review_state === "APPROVED") return "approved";
  if (snapshot.web_code_review_state === "ESCALATED") return "needs attention";
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

function userAction(stage: UserStage): string {
  switch (stage) {
    case "AWAITING_HUMAN": return "review the Draft PR and merge when ready";
    case "BLOCKED":
    case "FAILED": return "use /review for evidence and /doctor for recovery guidance";
    case "WEB_IMPLEMENTATION": return "None — WCO is preparing the implementation";
    case "REVISION": return "None — WCO is applying the requested review fixes";
    case "WEB_FINAL_REVIEW": return "None — WCO is waiting for the final review";
    case "TERRA_REVIEW":
    case "SOL_REVIEW": return "None — WCO is reviewing the exact change";
    case "EXECUTION": return "None — WCO is implementing the task";
    case "VERIFICATION": return "None — WCO is running checks";
    case "PUBLISHING":
    case "DRAFT_PR":
    case "RESULT_BUNDLE": return "None — WCO is preparing the reviewed Draft PR";
    case "PAUSED": return "use /run to continue saved progress";
    default: return "use /run if WCO is not already working";
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
    `Your action   ${userAction(stage)}`,
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
    `Your action   ${userAction(stage)}`,
  ].join("\n");
}
