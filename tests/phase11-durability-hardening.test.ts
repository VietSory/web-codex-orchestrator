import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkpointAttempt, completeAttempt, failAttempt, pauseRun } from "../src/orchestration/controller.js";
import { acquireRunLock } from "../src/orchestration/run-lock.js";
import { appendLedgerEvent, createRunLedger } from "../src/orchestration/ledger.js";
import { beginAttempt, decideRetry, sealTransitionRequest } from "../src/orchestration/retry-policy.js";
import { OrchestrationError } from "../src/orchestration/contracts.js";

const RUN_ID = `TASK-P11-HARD:${"d".repeat(64)}`;

test("P11-HARD-001 a live writer lock blocks a second mutator instead of allowing lost update", async (t) => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-lock-")); t.after(async () => fs.rm(root, { recursive: true, force: true })); const lock = await acquireRunLock(root, RUN_ID, { timeoutMs: 0 }); t.after(async () => lock.release()); await assert.rejects(() => pauseRun(root, RUN_ID, "racing writer"), (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_LOCKED"); await lock.release(); const paused = await pauseRun(root, RUN_ID, "serialized writer"); assert.equal(paused.paused, true); });

test("P11-HARD-002 late result cannot complete a newer retry attempt", async (t) => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-late-")); t.after(async () => fs.rm(root, { recursive: true, force: true })); const payload = { artifact: "e".repeat(64) }; const first = await checkpointAttempt({ stateDirectory: root, runId: RUN_ID, transition: "EXECUTE_REGISTERED_PACK", payload, now: new Date("2026-08-08T00:00:00.000Z") }); const firstId = first.current_attempt!.attempt_id; const failed = await failAttempt({ stateDirectory: root, runId: RUN_ID, attemptId: firstId, failureCode: "NETWORK_UNAVAILABLE", message: "retry me", retryOptions: { base_delay_ms: 1, maximum_delay_ms: 1, maximum_consecutive_failures: 5, circuit_open_ms: 10 }, now: new Date("2026-08-08T00:00:00.001Z") }); const due = new Date(Date.parse(failed.retry.next_retry_at!) + 1); const second = await checkpointAttempt({ stateDirectory: root, runId: RUN_ID, transition: "EXECUTE_REGISTERED_PACK", payload, now: due }); assert.notEqual(second.current_attempt!.attempt_id, firstId); await assert.rejects(() => completeAttempt({ stateDirectory: root, runId: RUN_ID, attemptId: firstId, result: { stale: true }, nextTransition: "PUBLISH", now: new Date(due.getTime() + 1) }), (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_ATTEMPT_CONFLICT"); });

test("P11-HARD-003 retry budget uses durable counters after event-tail compaction", () => { const now = new Date("2026-08-08T00:00:00.000Z"); const ledger = createRunLedger({ runId: RUN_ID, now }); const request = sealTransitionRequest("EXECUTE_REGISTERED_PACK", { artifact: "f".repeat(64) }); ledger.current_attempt = beginAttempt("EXECUTE_REGISTERED_PACK", request, 4, now); ledger.transition_attempts.EXECUTE_REGISTERED_PACK = 4; ledger.budget.total_attempts = 4; for (let index = 0; index < 200; index += 1) appendLedgerEvent(ledger, "noise", { index }, new Date(now.getTime() + index + 1)); assert.equal(ledger.events.length, 128); const decision = decideRetry(ledger, "NETWORK_UNAVAILABLE", new Date(now.getTime() + 500)); assert.equal(decision.retry, false); assert.equal(decision.reason, "transition attempt budget exhausted"); });
