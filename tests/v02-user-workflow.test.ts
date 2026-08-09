import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureRunLedger, pauseRun } from "../src/orchestration/controller.js";
import { runControlCommand, type ControlCliIo } from "../src/orchestration/control-cli.js";

function runId(task = "TASK-V02"): string {
  return `${task}:${"a".repeat(64)}`;
}

function captureIo(): { io: ControlCliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

test("v0.2 status presents progress and resource budgets for humans", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-v02-status-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const id = runId();
  await ensureRunLedger(state, id, new Date("2026-08-09T00:00:00.000Z"));

  const capture = captureIo();
  const code = await runControlCommand("status", ["--run-id", id, "--state-dir", state], capture.io);

  assert.equal(code, 0, capture.stderr.join("\n"));
  assert.equal(capture.stderr.length, 0);
  const output = capture.stdout.join("\n");
  assert.match(output, new RegExp(`Run: ${id}`));
  assert.match(output, /Progress/);
  assert.match(output, /✓ Run prepared/);
  assert.match(output, /● Web implementation registered/);
  assert.match(output, /Resources/);
  assert.match(output, /Attempts: 0\//);
  assert.match(output, /Model turns: 0\//);
  assert.match(output, /Input tokens: 0\//);
  assert.match(output, /Output tokens: 0\//);
  assert.match(output, /Next: REGISTER_WEB_PACK/);
});

test("v0.2 resume explains recovery without changing the JSON contract", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-v02-resume-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const humanId = runId("TASK-RESUME-HUMAN");
  await pauseRun(state, humanId, "test pause", new Date("2026-08-09T00:00:00.000Z"));

  const human = captureIo();
  const humanCode = await runControlCommand("resume", ["--run-id", humanId, "--state-dir", state], human.io);
  assert.equal(humanCode, 0, human.stderr.join("\n"));
  const humanOutput = human.stdout.join("\n");
  assert.match(humanOutput, new RegExp(`Resumed: ${humanId}`));
  assert.match(humanOutput, /re-attestation will run before the next side effect/);
  assert.match(humanOutput, /Progress/);
  assert.match(humanOutput, /Next: REGISTER_WEB_PACK/);

  const jsonId = runId("TASK-RESUME-JSON");
  await pauseRun(state, jsonId, "test pause", new Date("2026-08-09T00:00:00.000Z"));
  const json = captureIo();
  const jsonCode = await runControlCommand("resume", ["--run-id", jsonId, "--state-dir", state, "--json"], json.io);
  assert.equal(jsonCode, 0, json.stderr.join("\n"));
  const parsed = JSON.parse(json.stdout[0]!) as { run_id: string; paused: boolean; ledger?: unknown };
  assert.equal(parsed.run_id, jsonId);
  assert.equal(parsed.paused, false);
  assert.equal(parsed.ledger, undefined, "resume --json remains the raw ledger contract");
});
