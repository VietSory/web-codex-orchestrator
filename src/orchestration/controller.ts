import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { OrchestrationError, type RunLedger, type TransitionKind } from "./contracts.js";
import { appendLedgerEvent, createRunLedger, readRunLedger, recordDiagnostic, writeRunLedger } from "./ledger.js";
import { beginAttempt, decideRetry, sealTransitionRequest, type RetryOptions } from "./retry-policy.js";

function resultHash(value: unknown): string { return crypto.createHash("sha256").update(canonicalJsonBuffer(value)).digest("hex"); }

export async function ensureRunLedger(stateDirectory: string, runId: string, now = new Date()): Promise<RunLedger> {
  const existing = await readRunLedger(stateDirectory, runId);
  if (existing) return existing;
  const ledger = createRunLedger({ runId, now });
  appendLedgerEvent(ledger, "ledger:created", { run_id: runId }, now);
  await writeRunLedger(stateDirectory, ledger);
  return ledger;
}

export async function pauseRun(stateDirectory: string, runId: string, reason: string, now = new Date()): Promise<RunLedger> {
  const ledger = await ensureRunLedger(stateDirectory, runId, now);
  ledger.paused = true; ledger.status = "PAUSED"; ledger.pause_reason = reason.slice(0, 4096); ledger.updated_at = now.toISOString();
  appendLedgerEvent(ledger, "run:paused", { reason: ledger.pause_reason }, now);
  await writeRunLedger(stateDirectory, ledger); return ledger;
}

export async function resumeRun(stateDirectory: string, runId: string, now = new Date()): Promise<RunLedger> {
  const ledger = await ensureRunLedger(stateDirectory, runId, now);
  ledger.paused = false; ledger.pause_reason = null; ledger.status = ledger.retry.next_retry_at && Date.parse(ledger.retry.next_retry_at) > now.getTime() ? "WAITING" : "ACTIVE"; ledger.updated_at = now.toISOString();
  appendLedgerEvent(ledger, "run:resumed", { next_transition: ledger.next_transition }, now);
  await writeRunLedger(stateDirectory, ledger); return ledger;
}

export async function checkpointAttempt(options: { stateDirectory: string; runId: string; transition: TransitionKind; payload: unknown; now?: Date }): Promise<RunLedger> {
  const now = options.now ?? new Date();
  const ledger = await ensureRunLedger(options.stateDirectory, options.runId, now);
  if (ledger.paused) throw new OrchestrationError("ORCHESTRATION_PAUSED", "Run is paused; no new transition may start.");
  if (ledger.status === "BLOCKED" || ledger.status === "FAILED" || ledger.status === "COMPLETE") throw new OrchestrationError("ORCHESTRATION_TERMINAL", `Run status '${ledger.status}' cannot start another transition.`);
  if (ledger.retry.circuit_state === "OPEN" && ledger.retry.next_retry_at && Date.parse(ledger.retry.next_retry_at) > now.getTime()) throw new OrchestrationError("ORCHESTRATION_CIRCUIT_OPEN", `Circuit remains open until ${ledger.retry.next_retry_at}.`);
  const requestSha = sealTransitionRequest(options.transition, options.payload);
  if (ledger.current_attempt?.status === "STARTED") {
    if (ledger.current_attempt.transition !== options.transition || ledger.current_attempt.request_sha256 !== requestSha) throw new OrchestrationError("ORCHESTRATION_ATTEMPT_CONFLICT", "A different sealed transition attempt is already in progress.");
    return ledger;
  }
  if (ledger.budget.total_attempts >= ledger.budget.max_total_attempts) throw new OrchestrationError("ORCHESTRATION_BUDGET_EXHAUSTED", "Total transition attempt budget is exhausted.");
  const number = ledger.transition_attempts[options.transition] + 1;
  if (number > ledger.budget.max_attempts_per_transition) throw new OrchestrationError("ORCHESTRATION_BUDGET_EXHAUSTED", "Transition attempt budget is exhausted.");
  ledger.transition_attempts[options.transition] = number;
  ledger.current_attempt = beginAttempt(options.transition, requestSha, number, now);
  ledger.budget.total_attempts += 1;
  ledger.status = "ACTIVE";
  ledger.retry.next_retry_at = null;
  if (ledger.retry.circuit_state === "OPEN") ledger.retry.circuit_state = "HALF_OPEN";
  appendLedgerEvent(ledger, `attempt:${options.transition}`, { attempt_id: ledger.current_attempt.attempt_id, request_sha256: requestSha, attempt_number: number }, now);
  await writeRunLedger(options.stateDirectory, ledger);
  return ledger;
}

export async function completeAttempt(options: { stateDirectory: string; runId: string; result: unknown; nextTransition: TransitionKind; usage?: { model_turns?: number; input_tokens?: number; output_tokens?: number }; now?: Date }): Promise<RunLedger> {
  const now = options.now ?? new Date();
  const ledger = await ensureRunLedger(options.stateDirectory, options.runId, now);
  const attempt = ledger.current_attempt;
  if (!attempt || attempt.status !== "STARTED") throw new OrchestrationError("ORCHESTRATION_ATTEMPT_MISSING", "No active transition attempt exists.");
  attempt.status = "SUCCEEDED"; attempt.finished_at = now.toISOString(); attempt.result_sha256 = resultHash(options.result); attempt.failure_code = null;
  ledger.last_completed_transition = attempt.transition; ledger.next_transition = options.nextTransition; ledger.retry = { consecutive_failures: 0, next_retry_at: null, circuit_state: "CLOSED", circuit_opened_at: null, last_failure_code: null };
  ledger.budget.model_turns += Math.max(0, Math.trunc(options.usage?.model_turns ?? 0)); ledger.budget.input_tokens += Math.max(0, Math.trunc(options.usage?.input_tokens ?? 0)); ledger.budget.output_tokens += Math.max(0, Math.trunc(options.usage?.output_tokens ?? 0));
  const budgetExceeded = ledger.budget.model_turns > ledger.budget.max_model_turns || ledger.budget.input_tokens > ledger.budget.max_input_tokens || ledger.budget.output_tokens > ledger.budget.max_output_tokens;
  if (budgetExceeded && options.nextTransition !== "DONE") {
    recordDiagnostic(ledger, "ORCHESTRATION_BUDGET_EXHAUSTED", "Model/token budget was exceeded by the completed transition; no later transition may start automatically.", now);
    ledger.status = "BLOCKED";
  } else {
    ledger.status = options.nextTransition === "DONE" ? "COMPLETE" : options.nextTransition === "WAIT_HUMAN" || options.nextTransition === "WAIT_WEB_VERDICT" ? "WAITING" : "ACTIVE";
  }
  appendLedgerEvent(ledger, "attempt:succeeded", { transition: attempt.transition, attempt_id: attempt.attempt_id, result_sha256: attempt.result_sha256, next_transition: options.nextTransition, budget_exceeded: budgetExceeded }, now);
  ledger.current_attempt = null;
  await writeRunLedger(options.stateDirectory, ledger); return ledger;
}

export async function failAttempt(options: { stateDirectory: string; runId: string; failureCode: string; message: string; retryOptions?: RetryOptions; now?: Date }): Promise<RunLedger> {
  const now = options.now ?? new Date();
  const ledger = await ensureRunLedger(options.stateDirectory, options.runId, now);
  const attempt = ledger.current_attempt;
  if (!attempt || attempt.status !== "STARTED") throw new OrchestrationError("ORCHESTRATION_ATTEMPT_MISSING", "No active transition attempt exists.");
  ledger.retry.consecutive_failures += 1; ledger.retry.last_failure_code = options.failureCode;
  const decision = decideRetry(ledger, options.failureCode, now, options.retryOptions);
  attempt.status = decision.retry ? "RETRYABLE_FAILURE" : "TERMINAL_FAILURE"; attempt.finished_at = now.toISOString(); attempt.failure_code = options.failureCode; attempt.result_sha256 = null;
  recordDiagnostic(ledger, options.failureCode, options.message, now);
  if (decision.retry) {
    ledger.retry.next_retry_at = new Date(now.getTime() + decision.delay_ms).toISOString(); ledger.status = "WAITING";
  } else if (decision.reason === "circuit open") {
    ledger.retry.circuit_state = "OPEN"; ledger.retry.circuit_opened_at = now.toISOString(); ledger.retry.next_retry_at = new Date(now.getTime() + decision.delay_ms).toISOString(); ledger.status = "WAITING";
  } else {
    ledger.retry.next_retry_at = null; ledger.status = "BLOCKED";
  }
  appendLedgerEvent(ledger, "attempt:failed", { transition: attempt.transition, attempt_id: attempt.attempt_id, failure_code: options.failureCode, retry: decision.retry, delay_ms: decision.delay_ms, reason: decision.reason }, now);
  ledger.current_attempt = null;
  await writeRunLedger(options.stateDirectory, ledger); return ledger;
}
