import { deriveNextTransition, type LifecycleSnapshot } from "../orchestration/planner.js";

/**
 * PAIR becomes user-complete only after the exact change has passed
 * deterministic verification + the current independent Web code review, has
 * been published to an open Draft PR/Result Bundle, and ChatGPT Web has also
 * approved the final intent for that exact head. The code-review receipt is
 * re-attested into the lifecycle snapshot so restart cannot inherit a missing
 * or stale reviewer checkpoint merely because final review once ran later.
 */
export function pairSessionCanComplete(snapshot: LifecycleSnapshot): boolean {
  if (snapshot.executor_state !== "READY_FOR_PUBLISH"
    || snapshot.publish_state !== "PUSHED"
    || snapshot.draft_pr_state !== "OPEN"
    || !snapshot.result_bundle_ready
    || snapshot.web_code_review_state !== "APPROVED"
    || snapshot.web_review_state !== "APPROVED") return false;
  return deriveNextTransition(snapshot).transition === "WAIT_HUMAN";
}
