import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendLedgerEvent, createRunLedger, readRunLedger, recordDiagnostic, writeRunLedger } from "../src/orchestration/ledger.js";

const RUN_ID = `TASK-P11-LEDGER:${"a".repeat(64)}`;

test("P11-LEDGER-001 event history compacts to a bounded hash-chained tail", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-ledger-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ runId: RUN_ID, now: new Date("2026-08-08T00:00:00.000Z") });
  for (let index = 0; index < 200; index += 1) appendLedgerEvent(ledger, "synthetic", { index }, new Date(1_786_118_400_000 + index));
  assert.equal(ledger.events.length, 128);
  assert.equal(ledger.compacted_event_count, 72);
  assert.notEqual(ledger.history_anchor_hash, "0".repeat(64));
  await writeRunLedger(root, ledger);
  const recovered = await readRunLedger(root, RUN_ID);
  assert.equal(recovered?.events.length, 128);
  assert.equal(recovered?.compacted_event_count, 72);
});

test("P11-LEDGER-002 repeated identical diagnostics are deduplicated with counters", () => {
  const ledger = createRunLedger({ runId: RUN_ID });
  const now = new Date("2026-08-08T00:00:00.000Z");
  for (let index = 0; index < 100; index += 1) recordDiagnostic(ledger, "NETWORK_TIMEOUT", "same bounded diagnostic", new Date(now.getTime() + index));
  assert.equal(ledger.diagnostics.length, 1);
  assert.equal(ledger.diagnostics[0]?.count, 100);
});

test("P11-LEDGER-003 tampered event-chain bytes fail closed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-ledger-tamper-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const ledger = createRunLedger({ runId: RUN_ID });
  appendLedgerEvent(ledger, "first", { ok: true }, new Date());
  await writeRunLedger(root, ledger);
  const file = path.join(root, "orchestration", "runs", "TASK-P11-LEDGER", "a".repeat(64), "run-ledger.json");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { events: Array<{ kind: string }> };
  parsed.events[0]!.kind = "tampered";
  await fs.writeFile(file, JSON.stringify(parsed));
  await assert.rejects(() => readRunLedger(root, RUN_ID), /event hash chain is invalid/);
});
