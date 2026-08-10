import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionReceipt } from "../src/execution/contracts.js";
import type { DraftPullRequestReceipt } from "../src/pull-request/contracts.js";
import type { GitPublishReceipt } from "../src/publish/contracts.js";
import type { ResultBundleReceipt } from "../src/result-bundle/contracts.js";
import { driveAutopilotJob, readAutopilotReceipt } from "../src/orchestration/autopilot-job.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import type { WebReviewReceipt } from "../src/web-review/contracts.js";

const READY_EXECUTION = { state: "READY_FOR_PUBLISH", errors: [] } as unknown as ExecutionReceipt;
const PUSHED = { state: "PUSHED", commit_sha: "1".repeat(40), remote_branch_sha: "1".repeat(40) } as unknown as GitPublishReceipt;
const OPEN_DRAFT = { state: "OPEN", observed_draft: true, observed_state: "open", pull_number: 31 } as unknown as DraftPullRequestReceipt;
const READY_RESULT = { state: "READY_FOR_WEB_REVIEW", archive_sha256: "a".repeat(64) } as unknown as ResultBundleReceipt;
const APPROVED = { state: "APPROVED" } as unknown as WebReviewReceipt;

test("V04-AUTO-006 restart while waiting for Web reuses the durable review job", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-resume-"));
  const runId = `task-resume:${"3".repeat(64)}`;
  const firstController = new AbortController();
  let reviewCreates = 0;
  let firstPolls = 0;

  const firstBridge = {
    async waitForVerdict() {
      firstPolls += 1;
      return null;
    },
  } as unknown as WebBridge;

  try {
    const paused = await driveAutopilotJob({
      bridge: firstBridge,
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      signal: firstController.signal,
      dependencies: {
        execute: async () => READY_EXECUTION,
        publish: async () => PUSHED,
        draft: async () => OPEN_DRAFT,
        packageResult: async () => READY_RESULT,
        createFinalReview: async () => ({ job_id: `review-job-${++reviewCreates}` }),
        sleep: async () => { firstController.abort(); },
      },
    });

    assert.equal(paused.status, "PAUSED");
    assert.equal(paused.stage, "WAIT_WEB");
    assert.equal(paused.pending_review_job_id, "review-job-1");
    assert.equal(firstPolls, 1);
    const checkpoint = await readAutopilotReceipt(stateDirectory, runId);
    assert.equal(checkpoint?.pending_review_job_id, "review-job-1");

    let resumedCreateCalled = false;
    const secondBridge = {
      async waitForVerdict(jobId: string) {
        assert.equal(jobId, "review-job-1");
        return { review_id: "approved-resume" } as never;
      },
    } as unknown as WebBridge;
    const resumed = await driveAutopilotJob({
      bridge: secondBridge,
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies: {
        createFinalReview: async () => { resumedCreateCalled = true; return { job_id: "must-not-create" }; },
        materializeVerdict: async () => ({ verdict_path: "/tmp/approve.json", receipt: APPROVED }),
      },
    });

    assert.equal(resumedCreateCalled, false);
    assert.equal(reviewCreates, 1);
    assert.equal(resumed.status, "READY_FOR_YOU");
    assert.equal(resumed.stage, "DONE");
    assert.equal(resumed.pending_review_job_id, null);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-AUTO-007 an already completed durable job is idempotent", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-complete-"));
  const runId = `task-complete:${"4".repeat(64)}`;
  const bridge = { async waitForVerdict() { return { review_id: "approved" } as never; } } as unknown as WebBridge;
  const dependencies = {
    execute: async () => READY_EXECUTION,
    publish: async () => PUSHED,
    draft: async () => OPEN_DRAFT,
    packageResult: async () => READY_RESULT,
    createFinalReview: async () => ({ job_id: "review-job" }),
    materializeVerdict: async () => ({ verdict_path: "/tmp/approve.json", receipt: APPROVED }),
  };

  try {
    const first = await driveAutopilotJob({ bridge, runId, stateDirectory, configPath: path.join(stateDirectory, "config.json"), dependencies });
    assert.equal(first.status, "READY_FOR_YOU");
    let touched = false;
    const second = await driveAutopilotJob({
      bridge,
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies: { execute: async () => { touched = true; return READY_EXECUTION; } },
    });
    assert.equal(touched, false);
    assert.equal(second.status, "READY_FOR_YOU");
    assert.equal(second.stage, "DONE");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
