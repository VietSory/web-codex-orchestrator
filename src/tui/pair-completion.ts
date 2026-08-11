import type { LifecycleSnapshot } from "../orchestration/planner.js";

/**
 * Normal PAIR UX stops once the exact change has passed deterministic
 * verification + the selected model reviewer, has been published, and is
 * bound to an open Draft PR/Result Bundle. Web is the architecture authority
 * for PAIR authoring, not a second final reviewer.
 */
export function pairSessionCanComplete(snapshot: LifecycleSnapshot): boolean {
  return snapshot.executor_state === "READY_FOR_PUBLISH"
    && snapshot.publish_state === "PUSHED"
    && snapshot.draft_pr_state === "OPEN"
    && snapshot.result_bundle_ready;
}
