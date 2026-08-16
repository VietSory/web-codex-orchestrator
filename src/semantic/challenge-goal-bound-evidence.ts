import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import type { RepositoryBinding } from "../web-bridge/contracts.js";
import { buildSemanticChallengeEvidence, type SemanticChallengeEvidence, type SemanticChallengeRequest } from "./blind-challenge.js";
import type { SemanticEvidenceObservationInput } from "./evidence-index.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface GoalBoundSemanticChallengeEvidence {
  schema_version: "1.0";
  kind: "wco-semantic-goal-bound-challenge-evidence";
  challenge_id: string;
  repository: RepositoryBinding;
  original_goal_sha256: string;
  evidence: SemanticChallengeEvidence;
  goal_bound_evidence_sha256: string;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJsonBuffer(value)).digest("hex");
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return left.repository_id === right.repository_id && left.base_branch === right.base_branch && left.base_commit === right.base_commit;
}

function payload(value: Omit<GoalBoundSemanticChallengeEvidence, "goal_bound_evidence_sha256"> | GoalBoundSemanticChallengeEvidence): unknown {
  return {
    schema_version: value.schema_version,
    kind: value.kind,
    challenge_id: value.challenge_id,
    repository: value.repository,
    original_goal_sha256: value.original_goal_sha256,
    challenge_evidence_sha256: value.evidence.challenge_evidence_sha256,
  };
}

export function buildGoalBoundSemanticChallengeEvidence(options: {
  request: SemanticChallengeRequest;
  observations: readonly SemanticEvidenceObservationInput[];
}): GoalBoundSemanticChallengeEvidence {
  const evidence = buildSemanticChallengeEvidence({ request: options.request, observations: options.observations });
  const base = {
    schema_version: "1.0" as const,
    kind: "wco-semantic-goal-bound-challenge-evidence" as const,
    challenge_id: options.request.challenge_id,
    repository: structuredClone(options.request.repository),
    original_goal_sha256: digest(options.request.original_goal),
    evidence,
  };
  return { ...base, goal_bound_evidence_sha256: digest(payload(base)) };
}

export function assertGoalBoundSemanticChallengeEvidence(value: GoalBoundSemanticChallengeEvidence, request: SemanticChallengeRequest): void {
  if (!value || value.schema_version !== "1.0" || value.kind !== "wco-semantic-goal-bound-challenge-evidence") throw new Error("semantic challenge recovery requires goal-bound evidence.");
  if (value.challenge_id !== request.challenge_id || value.evidence.challenge_id !== request.challenge_id) throw new Error("semantic challenge goal-bound evidence belongs to another challenge.");
  if (!sameRepository(value.repository, request.repository) || !sameRepository(value.evidence.repository, request.repository)) throw new Error("semantic challenge goal-bound evidence repository binding drifted.");
  const goal = digest(request.original_goal);
  if (value.original_goal_sha256 !== goal) throw new Error("semantic challenge goal-bound evidence original goal drifted.");
  if (!SHA256.test(value.goal_bound_evidence_sha256) || value.goal_bound_evidence_sha256 !== digest(payload(value))) throw new Error("semantic challenge goal-bound evidence digest is invalid.");
}
