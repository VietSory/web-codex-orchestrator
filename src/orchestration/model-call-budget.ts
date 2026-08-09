import { appendLedgerEvent, readRunLedger, writeRunLedger } from "./ledger.js";
import { withRunLock } from "./run-lock.js";
import { OrchestrationError, type RunLedger } from "./contracts.js";

export interface ReserveModelTurnOptions {
  stateDirectory: string;
  runId: string;
  attemptId: string;
  role: "implementer" | "internal_reviewer" | "final_reviewer";
  now?: Date;
}

function budgetUnavailable(ledger: RunLedger, now: Date): string | null {
  const elapsed = now.getTime() - Date.parse(ledger.budget.started_at);
  if (!Number.isFinite(elapsed) || elapsed >= ledger.budget.max_elapsed_ms) return "elapsed orchestration budget is exhausted";
  if (ledger.budget.model_turns >= ledger.budget.max_model_turns) return "model-turn orchestration budget is exhausted";
  if (ledger.budget.input_tokens >= ledger.budget.max_input_tokens) return "measured input-token orchestration budget is exhausted";
  if (ledger.budget.output_tokens >= ledger.budget.max_output_tokens) return "measured output-token orchestration budget is exhausted";
  return null;
}

/**
 * Durably reserves one model turn immediately before the provider-backed call.
 * A reserved turn remains consumed after a crash, which deliberately favors
 * fail-safe over-counting instead of accidentally replaying beyond the limit.
 */
export async function reserveModelTurn(options: ReserveModelTurnOptions): Promise<RunLedger> {
  const now = options.now ?? new Date();
  return await withRunLock(options.stateDirectory, options.runId, async () => {
    const ledger = await readRunLedger(options.stateDirectory, options.runId);
    if (!ledger) throw new OrchestrationError("ORCHESTRATION_STATE_INVALID", "Cannot reserve a model turn before the run ledger exists.");
    const attempt = ledger.current_attempt;
    if (!attempt || attempt.status !== "STARTED" || attempt.attempt_id !== options.attemptId) {
      throw new OrchestrationError("ORCHESTRATION_ATTEMPT_CONFLICT", "Model turn reservation does not match the active sealed transition attempt.");
    }
    if (ledger.paused || ledger.status !== "ACTIVE") {
      throw new OrchestrationError("ORCHESTRATION_BUDGET_EXHAUSTED", "A model turn cannot start while the run is not active.");
    }
    const unavailable = budgetUnavailable(ledger, now);
    if (unavailable) throw new OrchestrationError("ORCHESTRATION_BUDGET_EXHAUSTED", `${unavailable}; provider call was not started.`);

    ledger.budget.model_turns += 1;
    appendLedgerEvent(ledger, "budget:model-turn-reserved", {
      attempt_id: attempt.attempt_id,
      transition: attempt.transition,
      role: options.role,
      reserved_model_turn: ledger.budget.model_turns,
    }, now);
    await writeRunLedger(options.stateDirectory, ledger);
    return ledger;
  });
}

export function measuredUsageOnly(usage: { input_tokens?: number; output_tokens?: number } | undefined): { model_turns: 0; input_tokens: number; output_tokens: number } | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) {
    throw new OrchestrationError("ORCHESTRATION_BUDGET_INVALID", "Measured model usage is outside safe integer bounds.");
  }
  return { model_turns: 0, input_tokens: input, output_tokens: output };
}
