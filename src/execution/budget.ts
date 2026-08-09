import type { AgentLimits } from "../config/contracts.js";
import { ExecutionError } from "./errors.js";

export interface Usage { implementationIterations: number; internalReviewRounds: number; solReviewRounds: number; totalTurns: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; startedAt: number; }

export class BudgetTracker {
  readonly usage: Usage;
  constructor(
    private readonly limits: AgentLimits,
    startedAt = Date.now(),
    initial?: Partial<Usage>,
    private readonly now: () => number = Date.now,
  ) {
    this.usage = { implementationIterations: initial?.implementationIterations ?? 0, internalReviewRounds: initial?.internalReviewRounds ?? 0, solReviewRounds: initial?.solReviewRounds ?? 0, totalTurns: initial?.totalTurns ?? 0, inputTokens: initial?.inputTokens ?? 0, cachedInputTokens: initial?.cachedInputTokens ?? 0, outputTokens: initial?.outputTokens ?? 0, startedAt };
  }
  private check(value: number, maximum: number): void { if (value >= maximum) throw new ExecutionError("BUDGET_EXHAUSTED", "Configured execution budget is exhausted."); }
  private measuredToken(value: number | undefined, label: string): number {
    if (!Number.isSafeInteger(value) || value! < 0) throw new ExecutionError("BUDGET_EXHAUSTED", `Provider ${label} usage is missing or invalid; token accounting cannot continue safely.`);
    return value!;
  }
  private addTokenUsage(current: number, delta: number): number {
    const total = current + delta;
    if (!Number.isSafeInteger(total)) throw new ExecutionError("BUDGET_EXHAUSTED", "Provider token usage overflowed safe integer accounting bounds.");
    return total;
  }
  beforeTurn(): void { this.check(this.usage.totalTurns, this.limits.maximum_total_agent_turns); if ((this.now() - this.usage.startedAt) / 1000 >= this.limits.maximum_total_seconds) throw new ExecutionError("BUDGET_EXHAUSTED", "Configured wall-clock budget is exhausted."); }
  beginAssessment(): void { this.beforeTurn(); this.usage.totalTurns += 1; }
  beginRepair(): void { this.beforeTurn(); this.usage.totalTurns += 1; }
  beginImplementation(): void { this.check(this.usage.implementationIterations, this.limits.maximum_implementation_iterations); this.beforeTurn(); this.usage.implementationIterations += 1; this.usage.totalTurns += 1; }
  beginInternalReview(): void { this.check(this.usage.internalReviewRounds, this.limits.maximum_internal_review_rounds); this.beforeTurn(); this.usage.internalReviewRounds += 1; this.usage.totalTurns += 1; }
  beginSolReview(): void { this.check(this.usage.solReviewRounds, this.limits.maximum_sol_review_rounds); this.beforeTurn(); this.usage.solReviewRounds += 1; this.usage.totalTurns += 1; }
  recordTokens(inputTokens: number | undefined, outputTokens: number | undefined, cachedInputTokens: number | undefined): void {
    const input = this.measuredToken(inputTokens, "input-token");
    const cached = this.measuredToken(cachedInputTokens, "cached-input-token");
    const output = this.measuredToken(outputTokens, "output-token");
    this.usage.inputTokens = this.addTokenUsage(this.usage.inputTokens, input);
    this.usage.cachedInputTokens = this.addTokenUsage(this.usage.cachedInputTokens, cached);
    this.usage.outputTokens = this.addTokenUsage(this.usage.outputTokens, output);
    if (this.usage.inputTokens + this.usage.cachedInputTokens > this.limits.maximum_total_input_tokens || this.usage.outputTokens > this.limits.maximum_total_output_tokens) throw new ExecutionError("BUDGET_EXHAUSTED", "Configured token budget is exhausted.");
  }
}

export function defaultAgentLimits(): AgentLimits {
  return { maximum_implementation_iterations: 8, maximum_internal_review_rounds: 4, maximum_sol_review_rounds: 3, maximum_total_agent_turns: 18, maximum_turn_seconds: 1800, maximum_total_seconds: 7200, maximum_total_input_tokens: 2_000_000, maximum_total_output_tokens: 300_000 };
}
