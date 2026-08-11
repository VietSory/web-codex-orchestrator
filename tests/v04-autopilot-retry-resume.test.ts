import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { driveAutopilotJob, readAutopilotReceipt } from "../src/orchestration/autopilot-job.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import { PUSHED, READY_EXECUTION, openDraft, readyResult } from "./v04-autopilot-fixtures.js";

test("V04-AUTO-008 restart during retry backoff honors the persisted deadline before normal completion", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-retry-resume-"));
  const runId = `task-retry-resume:${"6".repeat(64)}`;
  const controller = new AbortController();
  const initialNow = Date.parse("2030-01-01T00:00:00.000Z");
  let firstDelay = 0;
  try {
    const paused = await driveAutopilotJob({
      bridge: {} as WebBridge,
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      signal: controller.signal,
      now: () => new Date(initialNow),
      dependencies: {
        execute: async () => { throw Object.assign(new Error("temporary Codex timeout"), { code: "CODEX_TURN_TIMEOUT" }); },
        sleep: async (milliseconds) => { firstDelay = milliseconds; controller.abort(); },
      },
    });
    assert.equal(paused.status, "PAUSED");
    assert.equal(paused.stage, "EXECUTE");
    assert.ok(firstDelay > 0);
    assert.ok(paused.next_retry_at);
    assert.equal(Date.parse(paused.next_retry_at!), initialNow + firstDelay);
    assert.equal(paused.stage_attempts.EXECUTE, 1);
    const durable = await readAutopilotReceipt(stateDirectory, runId);
    assert.equal(durable?.next_retry_at, paused.next_retry_at);

    let currentNow = initialNow + Math.floor(firstDelay / 2);
    const events: string[] = [];
    let resumedSleep = 0;
    let webTouched = false;
    const bridge = { async waitForVerdict() { webTouched = true; throw new Error("normal AUTOPILOT must not poll Web review"); } } as unknown as WebBridge;
    const resumed = await driveAutopilotJob({
      bridge,
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      maxCycles: 5,
      now: () => new Date(currentNow),
      dependencies: {
        sleep: async (milliseconds) => { events.push("retry-deadline-sleep"); resumedSleep = milliseconds; currentNow += milliseconds; },
        execute: async () => { events.push("execute"); return READY_EXECUTION; },
        publish: async () => { events.push("publish"); return PUSHED; },
        draft: async () => { events.push("draft"); return openDraft(); },
        packageResult: async () => { events.push("package"); return readyResult(runId); },
        createFinalReview: async () => { webTouched = true; throw new Error("normal AUTOPILOT must not create Web review"); },
      },
    });
    assert.ok(resumedSleep > 0);
    assert.equal(resumedSleep, initialNow + firstDelay - (initialNow + Math.floor(firstDelay / 2)));
    assert.deepEqual(events, ["retry-deadline-sleep", "execute", "publish", "draft", "package"]);
    assert.equal(webTouched, false);
    assert.equal(resumed.status, "READY_FOR_YOU");
    assert.equal(resumed.stage, "DONE");
    assert.equal(resumed.next_retry_at, null);
    assert.equal(resumed.stage_attempts.EXECUTE, 0);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});
