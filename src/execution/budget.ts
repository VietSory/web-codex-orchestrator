import type { AgentLimits } from "../config/contracts.js";
import { ExecutionError } from "./errors.js";

export interface Usage { implementationIterations: number; internalReviewRounds: number; solReviewRounds: number; totalTurns: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; startedAt: number; }

export class BudgetTracker {
  readonly usage: Usage;
  constructor(private readonly limits: AgentLimits, startedAt = Date.now(), initial?: Partial<Usage>) {
    this.usage = { implementationIterations: initial?.implementationIterations ?? 0, internalReviewRounds: initial?.internalReviewRounds ?? 0, solReviewRounds: initial?.solReviewRounds ?? 0, totalTurns: initial?.totalTurns ?? 0, inputTokens: initial?.inputTokens ?? 0, cachedInputTokens: initial?.cachedInputTokens ?? 0, outputTokens: initial?.outputTokens ?? 0, startedAt };
  }
  private check(value: number, maximum: number): void { if (value >= maximum) throw new ExecutionError("BUDGET_EXHAUSTED", "Configured execution budget is exhausted."); }
  beforeTurn(): void { this.check(this.usage.totalTurns, this.limits.maximum_total_agent_turns); if ((Date.now() - this.usage.startedAt) / 1000 >= this.limits.maximum_total_seconds) throw new ExecutionError("BUDGET_EXHAUSTED", "Configured wall-clock budget is exhausted."); }
  beginAssessment(): void { this.beforeTurn(); this.usage.totalTurns += 1; }
  beginRepair(): void { this.beforeTurn(); this.usage.totalTurns += 1; }
  beginImplementation(): void { this.check(this.usage.implementationIterations, this.limits.maximum_implementation_iterations); this.beforeTurn(); this.usage.implementationIterations += 1; this.usage.totalTurns += 1; }
  beginInternalReview(): void { this.check(this.usage.internalReviewRounds, this.limits.maximum_internal_review_rounds); this.beforeTurn(); this.usage.internalReviewRounds += 1; this.usage.totalTurns += 1; }
  beginSolReview(): void { this.check(this.usage.solReviewRounds, this.limits.maximum_sol_review_rounds); this.beforeTurn(); this.usage.solReviewRounds += 1; this.usage.totalTurns += 1; }
  recordTokens(inputTokens: number | undefined, outputTokens: number | undefined, cachedInputTokens = 0): void { this.usage.inputTokens += inputTokens ?? 0; this.usage.cachedInputTokens += cachedInputTokens; this.usage.outputTokens += outputTokens ?? 0; if (this.usage.inputTokens + this.usage.cachedInputTokens > this.limits.maximum_total_input_tokens || this.usage.outputTokens > this.limits.maximum_total_output_tokens) throw new ExecutionError("BUDGET_EXHAUSTED", "Configured token budget is exhausted."); }
}

export function defaultAgentLimits(): AgentLimits {
  return { maximum_implementation_iterations: 8, maximum_internal_review_rounds: 4, maximum_sol_review_rounds: 3, maximum_total_agent_turns: 18, maximum_turn_seconds: 1800, maximum_total_seconds: 7200, maximum_total_input_tokens: 2_000_000, maximum_total_output_tokens: 300_000 };
}
