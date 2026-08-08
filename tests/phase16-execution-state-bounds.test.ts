import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAgentEvent,
  appendExecutionEvent,
  ensureExecutionDirectory,
  executionPaths,
  readExecutionReceipt,
} from "../src/execution/execution-store.js";

const TASK_ID = "TASK-P16-STATE";
const SHA = "a".repeat(64);
const RUN_ID = `${TASK_ID}:${SHA}`;

async function fixture(prefix: string) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = executionPaths(state, TASK_ID, SHA);
  await ensureExecutionDirectory(paths);
  return { state, paths };
}

test("P16-STATE-BOUND-001 execution journal sequence uses bounded tail and diagnostic lines remain bounded", async (t) => {
  const { state, paths } = await fixture("wco-p16-exec-journal-");
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  const hugeDetails = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field-${index}`, "x".repeat(32_768)]));

  await appendExecutionEvent(state, TASK_ID, SHA, RUN_ID, "CODEX_PREFLIGHT", "TERRA_ASSESSING", hugeDetails);
  await appendExecutionEvent(state, TASK_ID, SHA, RUN_ID, "TERRA_ASSESSING", "TERRA_IMPLEMENTING", { ok: true });

  const lines = (await fs.readFile(paths.events, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!) as { sequence: number; truncated?: boolean; original_bytes?: number };
  const second = JSON.parse(lines[1]!) as { sequence: number };
  assert.equal(first.sequence, 1);
  assert.equal(first.truncated, true);
  assert.ok((first.original_bytes ?? 0) > 256 * 1024);
  assert.equal(second.sequence, 2);
  assert.ok(Buffer.byteLength(lines[0]!) <= 256 * 1024);
  assert.ok(Buffer.byteLength(lines[1]!) <= 256 * 1024);
});

test("P16-STATE-BOUND-002 oversized agent diagnostic events preserve top-level event identity while bounding the line", async (t) => {
  const { state, paths } = await fixture("wco-p16-agent-journal-");
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  const payload = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field-${index}`, "y".repeat(32_768)]));
  await appendAgentEvent(state, TASK_ID, SHA, { event_type: "tool-summary", payload });
  const line = (await fs.readFile(paths.agentEvents, "utf8")).trim();
  const parsed = JSON.parse(line) as { event_type?: string; truncated?: boolean; original_bytes?: number };
  assert.equal(parsed.event_type, "tool-summary");
  assert.equal(parsed.truncated, true);
  assert.ok((parsed.original_bytes ?? 0) > 256 * 1024);
  assert.ok(Buffer.byteLength(line) <= 256 * 1024);
});

test("P16-STATE-BOUND-003 corrupted oversized execution receipts fail before unbounded allocation/parse", async (t) => {
  const { state, paths } = await fixture("wco-p16-exec-receipt-");
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  await fs.writeFile(paths.execution, `{"padding":"${"z".repeat(4 * 1024 * 1024)}"}`);
  await assert.rejects(readExecutionReceipt(state, TASK_ID, SHA), /JSON file exceeds the 4194304 byte safety limit/);
});
