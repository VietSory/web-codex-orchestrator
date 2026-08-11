import type { AgentConfig, AgentProfile, ReasoningEffort } from "../config/contracts.js";

export type ReviewerKind = "sol" | "terra";

export const REVIEWER_MODELS: Record<ReviewerKind, string> = {
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
};

export const DEFAULT_REVIEWER: Readonly<{ kind: ReviewerKind; profile: AgentProfile }> = {
  kind: "sol",
  profile: { model: REVIEWER_MODELS.sol, reasoning_effort: "high" },
};

export const REVIEWER_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"] as const;

export function reviewerKindForModel(model: string): ReviewerKind {
  if (model === REVIEWER_MODELS.sol) return "sol";
  if (model === REVIEWER_MODELS.terra) return "terra";
  throw new Error(`REVIEWER_MODEL_INVALID: normal review model must be '${REVIEWER_MODELS.sol}' or '${REVIEWER_MODELS.terra}'.`);
}

export function configuredSingleReviewer(agents: AgentConfig): { kind: ReviewerKind; profile: AgentProfile } | null {
  if (!agents.reviewer) return null;
  return { kind: reviewerKindForModel(agents.reviewer.model), profile: agents.reviewer };
}

export function effectiveReviewer(agents: AgentConfig): { kind: ReviewerKind; profile: AgentProfile; single: boolean } {
  const configured = configuredSingleReviewer(agents);
  if (configured) return { ...configured, single: true };
  return { kind: "sol", profile: agents.final_reviewer, single: false };
}

export function parseReviewerSelection(modelValue: string, effortValue: string): { kind: ReviewerKind; profile: AgentProfile } {
  const kind = modelValue.trim().toLowerCase();
  if (kind !== "sol" && kind !== "terra") throw new Error("REVIEWER_MODE_INVALID: model must be sol or terra.");
  const effort = effortValue.trim().toLowerCase();
  if (!REVIEWER_EFFORTS.includes(effort as ReasoningEffort)) throw new Error(`REVIEWER_EFFORT_INVALID: effort must be ${REVIEWER_EFFORTS.join(", ")}.`);
  return {
    kind,
    profile: { model: REVIEWER_MODELS[kind], reasoning_effort: effort as ReasoningEffort },
  };
}

export function reviewerLabel(profile: AgentProfile): string {
  const kind = reviewerKindForModel(profile.model);
  return `${kind === "sol" ? "Sol" : "Terra"} · ${profile.reasoning_effort}`;
}
