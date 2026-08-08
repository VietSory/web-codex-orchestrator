import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunLedger, readRunLedger, writeRunLedger } from "../src/orchestration/ledger.js";
import { OrchestrationError } from "../src/orchestration/contracts.js";

const HASH = "a".repeat(64);

function ledgerPath(root: string, runId: string): string {
  const split = runId.lastIndexOf(":");
  return path.join(root, "orchestration", "runs", runId.slice(0, split), runId.slice(split + 1), "run-ledger.json");
}

async function mutateLedger(root: string, runId: string, mutate: (ledger: Record<string, any>) => void): Promise<void> {
  const file = ledgerPath(root, runId);
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, any>;
  mutate(parsed);
  await fs.writeFile(file, JSON.stringify(parsed), "utf8");
}

async function expectInvalid(root: string, runId: string): Promise<void> {
  await assert.rejects(
    readRunLedger(root, runId),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_STATE_INVALID",
  );
}

test("P16-STATE-001 terminal failure metadata cannot masquerade as ACTIVE", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-ledger-terminal-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const runId = `TASK-P16-LEDGER-TERMINAL:${HASH}`;
  await writeRunLedger(root, createRunLedger({ runId, now: new Date("2026-08-08T00:00:00.000Z") }));
  await mutateLedger(root, runId, (ledger) => {
    ledger.status = "ACTIVE";
    ledger.retry.consecutive_failures = 1;
    ledger.retry.last_failure_code = "ORCHESTRATION_POLICY_BLOCKED";
    ledger.retry.next_retry_at = null;
  });
  await expectInvalid(root, runId);
});

test("P16-STATE-002 paused flag and PAUSED status must agree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-ledger-paused-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const runId = `TASK-P16-LEDGER-PAUSED:${HASH}`;
  await writeRunLedger(root, createRunLedger({ runId, now: new Date("2026-08-08T00:00:00.000Z") }));
  await mutateLedger(root, runId, (ledger) => {
    ledger.status = "PAUSED";
    ledger.paused = false;
    ledger.pause_reason = null;
  });
  await expectInvalid(root, runId);
});

test("P16-STATE-003 retry circuit enum and timing are runtime-validated", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-ledger-circuit-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const runId = `TASK-P16-LEDGER-CIRCUIT:${HASH}`;
  await writeRunLedger(root, createRunLedger({ runId, now: new Date("2026-08-08T00:00:00.000Z") }));
  await mutateLedger(root, runId, (ledger) => {
    ledger.retry.circuit_state = "BROKEN";
  });
  await expectInvalid(root, runId);
});

test("P16-STATE-004 durable attempt counters must equal total-attempt accounting", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p16-ledger-budget-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const runId = `TASK-P16-LEDGER-BUDGET:${HASH}`;
  await writeRunLedger(root, createRunLedger({ runId, now: new Date("2026-08-08T00:00:00.000Z") }));
  await mutateLedger(root, runId, (ledger) => {
    ledger.budget.total_attempts = 1;
  });
  await expectInvalid(root, runId);
});
