import { deriveNextTransition, type LifecycleSnapshot } from "../orchestration/planner.js";

/**
 * Browser PAIR is user-complete once deterministic verification + the one
 * independent pre-publish ChatGPT Web review gate have passed and the reviewed
 * exact head has been published to an open Draft PR/Result Bundle.
 *
 * Legacy PAIR keeps its historical post-publication code/final-review contract.
 */
export function pairSessionCanComplete(snapshot: LifecycleSnapshot): boolean {
  if (snapshot.executor_state !== "READY_FOR_PUBLISH"
    || snapshot.publish_state !== "PUSHED"
    || snapshot.draft_pr_state !== "OPEN"
    || !snapshot.result_bundle_ready) return false;

  if (snapshot.browser_review_gate_passed === true) {
    return deriveNextTransition(snapshot).transition === "WAIT_HUMAN";
  }

  if (snapshot.web_code_review_state !== "APPROVED"
    || snapshot.web_review_state !== "APPROVED") return false;
  return deriveNextTransition(snapshot).transition === "WAIT_HUMAN";
}
