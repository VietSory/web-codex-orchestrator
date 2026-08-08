import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { OrchestrationError, type RunLedger, type TransitionAttempt, type TransitionKind } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface RetryDecision {
  retry: boolean;
  delay_ms: number;
  reason: string;
}

export interface RetryOptions {
  base_delay_ms: number;
  maximum_delay_ms: number;
  maximum_consecutive_failures: number;
  circuit_open_ms: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  base_delay_ms: 1_000,
  maximum_delay_ms: 60_000,
  maximum_consecutive_failures: 5,
  circuit_open_ms: 120_000,
};

function deterministicJitter(requestSha256: string, attemptNumber: number, delayMs: number): number {
  const hash = crypto.createHash("sha256").update(`${requestSha256}:${attemptNumber}`).digest();
  const fraction = hash.readUInt32BE(0) / 0xffffffff;
  return Math.floor(delayMs * (0.75 + fraction * 0.5));
}

export function computeRetryDelay(requestSha256: string, attemptNumber: number, options: RetryOptions = DEFAULT_RETRY_OPTIONS): number {
  if (!SHA256.test(requestSha256) || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new OrchestrationError("ORCHESTRATION_RETRY_INVALID", "Retry identity is invalid.");
  const exponent = Math.min(30, attemptNumber - 1);
  const raw = Math.min(options.maximum_delay_ms, options.base_delay_ms * 2 ** exponent);
  return Math.min(options.maximum_delay_ms, deterministicJitter(requestSha256, attemptNumber, raw));
}

export function retryableFailureCode(code: string): boolean {
  return /(?:TIMEOUT|NETWORK|RATE_LIMIT|TEMPORARY|UNAVAILABLE|DISCONNECTED|RETRYABLE)/.test(code);
}

export function decideRetry(ledger: RunLedger, failureCode: string, now: Date, options: RetryOptions = DEFAULT_RETRY_OPTIONS): RetryDecision {
  const attempt = ledger.current_attempt;
  if (!attempt) return { retry: false, delay_ms: 0, reason: "no active attempt" };
  if (!retryableFailureCode(failureCode)) return { retry: false, delay_ms: 0, reason: "terminal failure class" };
  if (ledger.budget.total_attempts >= ledger.budget.max_total_attempts) return { retry: false, delay_ms: 0, reason: "total attempt budget exhausted" };
  const transitionAttempts = ledger.events.filter((event) => event.kind === `attempt:${attempt.transition}`).length;
  if (transitionAttempts >= ledger.budget.max_attempts_per_transition) return { retry: false, delay_ms: 0, reason: "transition attempt budget exhausted" };
  const elapsed = now.getTime() - Date.parse(ledger.budget.started_at);
  if (!Number.isFinite(elapsed) || elapsed > ledger.budget.max_elapsed_ms) return { retry: false, delay_ms: 0, reason: "elapsed budget exhausted" };
  if (ledger.retry.consecutive_failures >= options.maximum_consecutive_failures) return { retry: false, delay_ms: options.circuit_open_ms, reason: "circuit open" };
  return { retry: true, delay_ms: computeRetryDelay(attempt.request_sha256, attempt.attempt_number, options), reason: "retryable" };
}

export function sealTransitionRequest(transition: TransitionKind, payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalJsonBuffer({ transition, payload })).digest("hex");
}

export function beginAttempt(transition: TransitionKind, requestSha256: string, attemptNumber: number, now: Date): TransitionAttempt {
  if (!SHA256.test(requestSha256)) throw new OrchestrationError("ORCHESTRATION_REQUEST_INVALID", "Transition request SHA-256 is invalid.");
  const attemptId = crypto.createHash("sha256").update(`${transition}:${requestSha256}:${attemptNumber}`).digest("hex").slice(0, 32);
  return { transition, attempt_id: attemptId, request_sha256: requestSha256, status: "STARTED", attempt_number: attemptNumber, started_at: now.toISOString(), finished_at: null, result_sha256: null, failure_code: null };
}
