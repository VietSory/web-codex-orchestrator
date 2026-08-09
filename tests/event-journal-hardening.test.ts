import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendRunEvent } from "../src/run/event-journal.js";

const runId = `TASK-JOURNAL:${"a".repeat(64)}`;
const taskId = "TASK-JOURNAL";
const archive = "a".repeat(64);

function event(sequence: number): string {
  return JSON.stringify({ event_version: "1.0", run_id: runId, sequence, from: "DISCOVERED", to: "ACCEPTED", timestamp: "2026-08-08T00:00:00.000Z", details: { padding: "x".repeat(64) } });
}

test("EVENT-JOURNAL-001 recovers the next sequence from only the final durable record", async (t) => {
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-event-journal-")));
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  const directory = path.join(state, "runs", taskId, archive);
  await fs.mkdir(directory, { recursive: true });
  const journal = path.join(directory, "events.jsonl");
  const records = Array.from({ length: 5000 }, (_, index) => event(index + 1)).join("\n") + "\n";
  await fs.writeFile(journal, records, { mode: 0o600 });

  const appended = await appendRunEvent(state, taskId, archive, runId, "ACCEPTED", "READY_FOR_CODEX", { ok: true }, () => new Date("2026-08-08T00:00:01.000Z"));
  assert.equal(appended.sequence, 5001);
  const tail = (await fs.readFile(journal, "utf8")).trimEnd().split("\n").at(-1);
  assert.equal((JSON.parse(tail!) as { sequence: number }).sequence, 5001);
});

test("EVENT-JOURNAL-002 malformed final authority fails closed instead of silently reusing a sequence", async (t) => {
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-event-journal-bad-")));
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  const directory = path.join(state, "runs", taskId, archive);
  await fs.mkdir(directory, { recursive: true });
  const journal = path.join(directory, "events.jsonl");
  await fs.writeFile(journal, `${event(1)}\nnot-json\n`, { mode: 0o600 });

  await assert.rejects(
    () => appendRunEvent(state, taskId, archive, runId, "ACCEPTED", "READY_FOR_CODEX"),
    /invalid final record/,
  );
});
