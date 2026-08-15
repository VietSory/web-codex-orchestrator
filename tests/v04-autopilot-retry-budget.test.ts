import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { driveAutopilotJob } from "../src/orchestration/autopilot-job.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import { PUSHED, READY_EXECUTION, openDraft, readyResult, webReview } from "./v04-autopilot-fixtures.js";

test("V04-AUTO-004 retryable execution failures back off, recover, then still require Web final review", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-retry-"));
  const runId = `task-retry:${"1".repeat(64)}`;
  let executeCalls = 0;
  let retrySleeps = 0;
  let reviewCreates = 0;
  let webPolls = 0;
  const bridge = { async waitForVerdict() { webPolls += 1; return { review_id: "approved-after-retry" } as never; } } as unknown as WebBridge;
  try {
    const receipt = await driveAutopilotJob({
      bridge,
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      maxCycles: 5,
      dependencies: {
        execute: async () => {
          executeCalls += 1;
          if (executeCalls < 3) throw Object.assign(new Error("temporary Codex turn timeout"), { code: "CODEX_TURN_TIMEOUT" });
          return READY_EXECUTION;
        },
        publish: async () => PUSHED,
        draft: async () => openDraft(),
        packageResult: async () => readyResult(runId),
        createFinalReview: async () => ({ job_id: `review-${++reviewCreates}` }),
        materializeVerdict: async () => ({ verdict_path: "/tmp/approve.json", receipt: webReview("APPROVED", runId) }),
        sleep: async () => { retrySleeps += 1; },
      },
    });
    assert.equal(executeCalls, 3);
    assert.equal(retrySleeps, 2);
    assert.equal(reviewCreates, 1);
    assert.equal(webPolls, 1);
    assert.equal(receipt.web_review_rounds, 1);
    assert.equal(receipt.status, "READY_FOR_YOU");
    assert.equal(receipt.stage, "DONE");
    assert.equal(receipt.stage_attempts.EXECUTE, 0);
    assert.doesNotMatch(receipt.reason ?? "", /CYCLE_BUDGET_EXHAUSTED/);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});

test("V04-AUTO-005 non-retryable service failures stop at NEEDS_YOU before publication or Web review", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-terminal-"));
  let webTouched = false;
  try {
    const receipt = await driveAutopilotJob({
      bridge: { async waitForVerdict() { webTouched = true; return null; } } as unknown as WebBridge,
      runId: `task-terminal:${"2".repeat(64)}`,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies: {
        execute: async () => { throw Object.assign(new Error("policy denied"), { code: "PATH_POLICY_VIOLATION" }); },
        createFinalReview: async () => { webTouched = true; return { job_id: "must-not-create" }; },
        sleep: async () => { throw new Error("must not retry terminal policy failure"); },
      },
    });
    assert.equal(webTouched, false);
    assert.equal(receipt.status, "NEEDS_YOU");
    assert.equal(receipt.terminal_action, "ASK_USER_TO_INTERVENE");
    assert.match(receipt.reason ?? "", /PATH_POLICY_VIOLATION/);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});
