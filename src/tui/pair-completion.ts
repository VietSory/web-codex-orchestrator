import { deriveNextTransition, type LifecycleSnapshot } from "../orchestration/planner.js";

export function pairSessionCanComplete(snapshot: LifecycleSnapshot): boolean {
  if (snapshot.web_review_state !== "APPROVED") return false;
  const next = deriveNextTransition(snapshot);
  return next.transition === "WAIT_HUMAN" && next.requires_human;
}
