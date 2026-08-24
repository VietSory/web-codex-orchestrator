import type { AgentProfile, ReasoningEffort } from "../config/contracts.js";

export type ReviewerKind = "sol" | "terra";

export interface ReviewerSelection {
  kind: ReviewerKind;
  model: string;
  reasoning_effort: ReasoningEffort;
}

export const REVIEWER_MODELS: Record<ReviewerKind, string> = {
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
};

export const DEFAULT_REVIEWER: Readonly<ReviewerSelection> = {
  kind: "sol",
  model: REVIEWER_MODELS.sol,
  reasoning_effort: "high",
};

export const REVIEWER_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"] as const;

export function reviewerKindForModel(model: string): ReviewerKind {
  if (model === REVIEWER_MODELS.sol) return "sol";
  if (model === REVIEWER_MODELS.terra) return "terra";
  throw new Error(`REVIEWER_MODEL_INVALID: normal review model must be '${REVIEWER_MODELS.sol}' or '${REVIEWER_MODELS.terra}'.`);
}

export function parseReviewerSelection(modelValue: string, effortValue: string): ReviewerSelection {
  const kind = modelValue.trim().toLowerCase();
  if (kind !== "sol" && kind !== "terra") throw new Error("REVIEWER_MODE_INVALID: model must be sol or terra.");
  const effort = effortValue.trim().toLowerCase();
  if (!REVIEWER_EFFORTS.includes(effort as ReasoningEffort)) throw new Error(`REVIEWER_EFFORT_INVALID: effort must be ${REVIEWER_EFFORTS.join(", ")}.`);
  return {
    kind,
    model: REVIEWER_MODELS[kind],
    reasoning_effort: effort as ReasoningEffort,
  };
}

export function selectionProfile(selection: ReviewerSelection): AgentProfile {
  return { model: selection.model, reasoning_effort: selection.reasoning_effort };
}

export function reviewerLabel(selection: ReviewerSelection): string {
  if (selection.model === "chatgpt-web") return "ChatGPT Web · independent";
  return `${selection.kind === "sol" ? "Sol" : "Terra"} · ${selection.reasoning_effort}`;
}
