import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import type { SemanticChallengeEvidence, SemanticChallengeRequest } from "./blind-challenge.js";
import {
  persistSemanticChallengeEvidenceSnapshot,
  readLatestSemanticChallengeEvidenceSnapshot,
  type SemanticChallengeEvidenceSnapshot,
} from "./challenge-evidence-store.js";
import {
  assertGoalBoundSemanticChallengeEvidence,
  goalBoundSemanticChallengeEvidenceDigest,
  type GoalBoundSemanticChallengeEvidence,
} from "./challenge-goal-bound-evidence.js";
import {
  readSemanticChallengeTrajectory,
  type SemanticChallengeTrajectoryReceipt,
} from "./challenge-trajectory-store.js";

const SHA256 = /^[a-f0-9]{64}$/;

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJsonBuffer(value)).digest("hex");
}

function sameRepository(left: SemanticChallengeRequest["repository"], right: SemanticChallengeRequest["repository"]): boolean {
  return left.repository_id === right.repository_id && left.base_branch === right.base_branch && left.base_commit === right.base_commit;
}

function trajectoryPayload(receipt: SemanticChallengeTrajectoryReceipt): unknown {
  return {
    schema_version: receipt.schema_version,
    kind: receipt.kind,
    challenge_id: receipt.challenge_id,
    repository: receipt.repository,
    original_goal_sha256: receipt.original_goal_sha256,
    sequence: receipt.sequence,
    event_type: receipt.event_type,
    idempotency_key_sha256: receipt.idempotency_key_sha256,
    payload_sha256: receipt.payload_sha256,
    previous_receipt_sha256: receipt.previous_receipt_sha256,
  };
}

function evidenceObservationPayload(request: SemanticChallengeRequest, evidence: SemanticChallengeEvidence): unknown {
  return {
    goal_bound_evidence_sha256: goalBoundSemanticChallengeEvidenceDigest(request, evidence),
    challenge_evidence_sha256: evidence.challenge_evidence_sha256,
    observation_count: evidence.evidence_index.observations.length,
  };
}

function assertTrajectoryObservationBinding(options: {
  request: SemanticChallengeRequest;
  evidence: SemanticChallengeEvidence;
  receipt: SemanticChallengeTrajectoryReceipt;
}): void {
  const count = options.evidence.evidence_index.observations.length;
  const receipt = options.receipt;
  if (receipt.schema_version !== "1.0" || receipt.kind !== "wco-semantic-challenge-trajectory-event" || receipt.event_type !== "repository_observation") throw new Error("semantic challenge recovery evidence requires a repository_observation trajectory receipt.");
  if (receipt.challenge_id !== options.request.challenge_id || !sameRepository(receipt.repository, options.request.repository)) throw new Error("semantic challenge recovery trajectory identity drifted.");
  if (receipt.original_goal_sha256 !== digest(options.request.original_goal)) throw new Error("semantic challenge recovery trajectory original goal drifted.");
  if (receipt.sequence !== count + 1) throw new Error("semantic challenge recovery trajectory sequence does not match evidence observation count.");
  if (!SHA256.test(receipt.receipt_sha256) || receipt.receipt_sha256 !== digest(trajectoryPayload(receipt))) throw new Error("semantic challenge recovery trajectory receipt digest is invalid.");
  if (receipt.payload_sha256 !== digest(evidenceObservationPayload(options.request, options.evidence))) throw new Error("semantic challenge recovery trajectory payload does not bind the exact goal-bound evidence snapshot.");
}

export async function persistTrajectoryBoundSemanticChallengeEvidence(options: {
  stateDirectory: string;
  request: SemanticChallengeRequest;
  goalBoundEvidence: GoalBoundSemanticChallengeEvidence;
  trajectoryReceipt: SemanticChallengeTrajectoryReceipt;
}): Promise<{ snapshot: SemanticChallengeEvidenceSnapshot; path: string; status: "created" | "replayed" }> {
  assertGoalBoundSemanticChallengeEvidence(options.goalBoundEvidence, options.request);
  const evidence = options.goalBoundEvidence.evidence;
  assertTrajectoryObservationBinding({ request: options.request, evidence, receipt: options.trajectoryReceipt });
  return await persistSemanticChallengeEvidenceSnapshot({
    stateDirectory: options.stateDirectory,
    request: options.request,
    trajectoryReceiptSha256: options.trajectoryReceipt.receipt_sha256,
    evidence,
  });
}

export async function readLatestTrajectoryBoundSemanticChallengeEvidence(options: {
  stateDirectory: string;
  request: SemanticChallengeRequest;
}): Promise<SemanticChallengeEvidenceSnapshot | null> {
  const trajectory = await readSemanticChallengeTrajectory(options);
  const observations = trajectory.filter((item) => item.event_type === "repository_observation");
  const snapshot = await readLatestSemanticChallengeEvidenceSnapshot(options);
  if (!snapshot) {
    if (observations.length > 0) throw new Error("semantic challenge recovery found repository observations without durable evidence snapshots.");
    return null;
  }
  if (snapshot.observation_count !== observations.length) throw new Error("semantic challenge recovery trajectory/evidence observation counts diverged.");
  const receipt = observations.at(-1);
  if (!receipt || receipt.receipt_sha256 !== snapshot.trajectory_receipt_sha256) throw new Error("semantic challenge recovery evidence does not reference the latest repository observation receipt.");
  assertTrajectoryObservationBinding({ request: options.request, evidence: snapshot.evidence, receipt });
  return snapshot;
}

export function semanticChallengeEvidenceTrajectoryPayload(request: SemanticChallengeRequest, goalBoundEvidence: GoalBoundSemanticChallengeEvidence): unknown {
  assertGoalBoundSemanticChallengeEvidence(goalBoundEvidence, request);
  return evidenceObservationPayload(request, goalBoundEvidence.evidence);
}
