// Canonical decision-event.json builder for Phase 7
import crypto from "node:crypto";
import { WebReviewError } from "./contracts.js";
import type { DecisionEvent, DecisionAction, DecisionState, WebReviewVerdict } from "./contracts.js";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export interface BuiltDecisionEvent {
  decisionEvent: DecisionEvent;
  canonicalBuffer: Buffer;
  decisionEventSha256: string;
}

/** Build canonical decision-event.json from a validated verdict */
export function buildDecisionEvent(
  verdict: WebReviewVerdict,
  verdictSha256: string,
  revisionRequestSha256: string | null,
  createdAt: string
): BuiltDecisionEvent {
  let state: DecisionState;
  let action: DecisionAction;

  if (verdict.verdict === "APPROVE") {
    state = "APPROVED";
    action = "ASK_USER_TO_MERGE";
  } else if (verdict.verdict === "REVISE") {
    state = "REVISION_REQUESTED";
    action = "NO_USER_MERGE_PROMPT";
  } else if (verdict.verdict === "ESCALATE") {
    state = "ESCALATED";
    action = "NOTIFY_USER_EXCEPTION";
  } else {
    throw new WebReviewError("WEB_REVIEW_OPERATIONAL_ERROR", `Unknown verdict type: '${(verdict as any).verdict}'`);
  }

  const decisionEvent: DecisionEvent = {
    schema_version: "1.1",
    kind: "wco-decision-event",
    run_id: verdict.run_id,
    review_mode: verdict.review_mode,
    review_round: verdict.review_round,
    state,
    action,
    verdict_sha256: verdictSha256,
    revision_request_sha256: revisionRequestSha256,
    result_bundle_sha256: verdict.result_bundle_sha256,
    published_commit_sha: verdict.published_commit_sha,
    pull_request_number: verdict.pull_request_number,
    observed_head_sha: verdict.observed_head_sha,
    created_at: createdAt,
  };

  const canonicalBuffer = canonicalJsonBuffer(decisionEvent);
  const decisionEventSha256 = sha256Hex(canonicalBuffer);

  return {
    decisionEvent,
    canonicalBuffer,
    decisionEventSha256,
  };
}
