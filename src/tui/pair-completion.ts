import { deriveNextTransition, type LifecycleSnapshot } from "../orchestration/planner.js";

/**
 * PAIR becomes user-complete only after the exact change has passed
 * deterministic verification + the selected code reviewer, has been published
 * to an open Draft PR/Result Bundle, and ChatGPT Web has independently approved
 * that exact head. The planner must therefore be at the human merge boundary.
 */
export function pairSessionCanComplete(snapshot: LifecycleSnapshot): boolean {
  if (snapshot.executor_state !== "READY_FOR_PUBLISH"
    || snapshot.publish_state !== "PUSHED"
    || snapshot.draft_pr_state !== "OPEN"
    || !snapshot.result_bundle_ready
    || snapshot.web_review_state !== "APPROVED") return false;
  return deriveNextTransition(snapshot).transition === "WAIT_HUMAN";
}
