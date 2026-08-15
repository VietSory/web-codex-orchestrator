import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionReceipt } from "../src/execution/contracts.js";
import { driveAutopilotJob, readAutopilotReceipt, type AutopilotDependencies } from "../src/orchestration/autopilot-job.js";
import { driveJob } from "../src/orchestration/job-orchestrator.js";
import { parseJobMode } from "../src/orchestration/job-mode.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import { COMMIT_2, PUSHED, READY_EXECUTION, READY_REVISION, openDraft, readyResult, webReview } from "./v04-autopilot-fixtures.js";

test("V04-MODE-001 PAIR is the default and never silently enters AUTOPILOT", async () => {
  assert.equal(parseJobMode(undefined), "PAIR");
  assert.equal(parseJobMode("autopilot"), "AUTOPILOT");
  assert.throws(() => parseJobMode("unguarded"), /JOB_MODE_INVALID/);
  let touchedAutopilot = false;
  const result = await driveJob({
    bridge: {} as WebBridge,
    runId: "not-needed-in-pair",
    stateDirectory: "not-needed-in-pair",
    configPath: "not-needed-in-pair",
    dependencies: { execute: async () => { touchedAutopilot = true; return READY_EXECUTION; } },
  });
  assert.equal(result.mode, "PAIR");
  assert.equal(result.status, "INTERACTIVE");
  assert.equal(touchedAutopilot, false);
});

test("V04-AUTO-001 AUTOPILOT requires selected code review plus Web final review and same-PR revision loop", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-"));
  const runId = `task-auto:${"a".repeat(64)}`;
  const calls: string[] = [];
  let reviewJobs = 0;
  let verdicts = 0;
  let polls = 0;
  const bridge = {
    async waitForVerdict() {
      polls += 1;
      if (polls === 1) return null;
      verdicts += 1;
      return { review_id: `review-${verdicts}` } as never;
    },
  } as unknown as WebBridge;
  const dependencies: Partial<AutopilotDependencies> = {
    execute: async () => { calls.push("execute"); return READY_EXECUTION; },
    publish: async () => { calls.push("publish"); return PUSHED; },
    draft: async () => { calls.push("draft"); return openDraft(); },
    packageResult: async () => { calls.push("package"); return readyResult(runId); },
    createFinalReview: async () => { calls.push("web-job"); return { job_id: `job-${++reviewJobs}` }; },
    materializeVerdict: async () => {
      calls.push("verdict");
      return { verdict_path: `/tmp/verdict-${verdicts}.json`, receipt: verdicts === 1 ? webReview("REVISION_REQUESTED", runId) : webReview("APPROVED", runId, COMMIT_2) };
    },
    attestRevision: async () => { calls.push("attest-revision"); return { revisionRound: 1 }; },
    revise: async () => { calls.push("revise"); return READY_REVISION; },
    sleep: async () => undefined,
  };
  try {
    const receipt = await driveAutopilotJob({ bridge, runId, stateDirectory, configPath: path.join(stateDirectory, "config.json"), dependencies, maxCycles: 16 });
    assert.equal(receipt.status, "READY_FOR_YOU");
    assert.equal(receipt.stage, "DONE");
    assert.equal(receipt.terminal_action, "ASK_USER_TO_MERGE");
    assert.equal(receipt.web_review_rounds, 2);
    assert.equal(receipt.revision_rounds_completed, 1);
    assert.equal(reviewJobs, 2);
    assert.deepEqual(calls, ["execute", "publish", "draft", "package", "web-job", "verdict", "attest-revision", "revise", "web-job", "verdict"]);
    const durable = await readAutopilotReceipt(stateDirectory, runId);
    assert.equal(durable?.status, "READY_FOR_YOU");
    assert.equal(durable?.stage, "DONE");
    assert.ok((durable?.generation ?? 0) > 0);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});

test("V04-AUTO-002 execution replan/human boundaries stop instead of weakening the contract", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-replan-"));
  const runId = `task-replan:${"e".repeat(64)}`;
  const execution = { state: "REPLAN_REQUIRED", errors: [{ code: "REPLAN_REQUIRED", message: "Repository facts conflict with the frozen plan." }] } as unknown as ExecutionReceipt;
  let published = false;
  try {
    const receipt = await driveAutopilotJob({ bridge: {} as WebBridge, runId, stateDirectory, configPath: path.join(stateDirectory, "config.json"), dependencies: { execute: async () => execution, publish: async () => { published = true; return PUSHED; } } });
    assert.equal(published, false);
    assert.equal(receipt.status, "NEEDS_YOU");
    assert.equal(receipt.stage, "EXECUTE");
    assert.equal(receipt.terminal_action, "ASK_USER_TO_INTERVENE");
    assert.match(receipt.reason ?? "", /REPLAN_REQUIRED/);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});
