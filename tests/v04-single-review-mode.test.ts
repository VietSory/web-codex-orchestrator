import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_REVIEWER, parseReviewerSelection } from "../src/agent/reviewer-selection.js";
import { effectiveRunReviewMode, freezeRunReviewMode, readReviewMode, writeReviewMode } from "../src/agent/reviewer-mode-store.js";
import { driveAutopilotJob } from "../src/orchestration/autopilot-job.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import { PUSHED, READY_EXECUTION, openDraft, readyResult, webReview } from "./v04-autopilot-fixtures.js";

test("V04-MODE-002 reviewer mode defaults to Sol/high and persists an explicit Terra effort", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-review-mode-"));
  try {
    assert.deepEqual(await readReviewMode(stateDirectory), DEFAULT_REVIEWER);
    const terra = parseReviewerSelection("terra", "xhigh");
    await writeReviewMode(stateDirectory, terra, () => new Date("2030-01-01T00:00:00.000Z"));
    assert.deepEqual(await readReviewMode(stateDirectory), terra);
    assert.throws(() => parseReviewerSelection("both", "high"), /model must be sol or terra/);
    assert.throws(() => parseReviewerSelection("sol", "ultra"), /effort must be/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-MODE-003 a run keeps its frozen reviewer after the global /mode preference changes", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-review-mode-freeze-"));
  const runId = `task-review-mode:${"c".repeat(64)}`;
  try {
    const sol = parseReviewerSelection("sol", "high");
    const terra = parseReviewerSelection("terra", "xhigh");
    await writeReviewMode(stateDirectory, sol);
    await freezeRunReviewMode(stateDirectory, runId, sol);
    await writeReviewMode(stateDirectory, terra);
    assert.deepEqual(await readReviewMode(stateDirectory), terra);
    assert.deepEqual(await effectiveRunReviewMode(stateDirectory, runId), sol);
    await assert.rejects(freezeRunReviewMode(stateDirectory, runId, terra), /REVIEW_MODE_RUN_DRIFT/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-AUTO-010 normal AUTOPILOT requires Web final approval after the selected code reviewer", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-single-review-"));
  const runId = `task-single-review:${"d".repeat(64)}`;
  let packageCalls = 0;
  let reviewCreates = 0;
  let webPolls = 0;
  let revalidations = 0;
  const bridge = { async waitForVerdict() { webPolls += 1; return { review_id: "approved" } as never; } } as unknown as WebBridge;
  const dependencies = {
    execute: async () => READY_EXECUTION,
    publish: async () => PUSHED,
    draft: async () => openDraft(),
    packageResult: async () => { packageCalls += 1; return readyResult(runId); },
    createFinalReview: async () => ({ job_id: `review-${++reviewCreates}` }),
    materializeVerdict: async () => ({ verdict_path: "/tmp/approve.json", receipt: webReview("APPROVED", runId) }),
    revalidateReady: async () => { revalidations += 1; return webReview("APPROVED", runId); },
  };
  try {
    const first = await driveAutopilotJob({ bridge, runId, stateDirectory, configPath: path.join(stateDirectory, "config.json"), dependencies });
    assert.equal(first.status, "READY_FOR_YOU");
    assert.equal(first.stage, "DONE");
    assert.equal(first.terminal_action, "ASK_USER_TO_MERGE");
    assert.equal(first.web_review_rounds, 1);
    assert.equal(first.revision_rounds_completed, 0);
    assert.equal(reviewCreates, 1);
    assert.equal(webPolls, 1);
    assert.equal(packageCalls, 1);

    const second = await driveAutopilotJob({ bridge, runId, stateDirectory, configPath: path.join(stateDirectory, "config.json"), dependencies });
    assert.equal(second.status, "READY_FOR_YOU");
    assert.equal(revalidations, 1, "READY reread must freshly re-attest the mandatory Web approval");
    assert.equal(packageCalls, 1, "READY reread must not substitute Result Bundle attestation for Web approval");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-AUTO-011 mandatory Web final review cannot be bypassed after packaging", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-required-web-"));
  const runId = `task-required-web:${"e".repeat(64)}`;
  let reviewCreates = 0;
  const bridge = { async waitForVerdict() { return null; } } as unknown as WebBridge;
  const controller = new AbortController();
  try {
    const receipt = await driveAutopilotJob({
      bridge,
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      signal: controller.signal,
      dependencies: {
        execute: async () => READY_EXECUTION,
        publish: async () => PUSHED,
        draft: async () => openDraft(),
        packageResult: async () => readyResult(runId),
        createFinalReview: async () => ({ job_id: `required-${++reviewCreates}` }),
        sleep: async () => controller.abort(),
      },
    });
    assert.equal(reviewCreates, 1);
    assert.equal(receipt.status, "PAUSED");
    assert.equal(receipt.stage, "WAIT_WEB");
    assert.notEqual(receipt.status, "READY_FOR_YOU");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
