import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionReceipt } from "../src/execution/contracts.js";
import type { DraftPullRequestReceipt } from "../src/pull-request/contracts.js";
import type { GitPublishReceipt } from "../src/publish/contracts.js";
import type { ResultBundleReceipt } from "../src/result-bundle/contracts.js";
import { driveAutopilotJob } from "../src/orchestration/autopilot-job.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import type { WebReviewReceipt } from "../src/web-review/contracts.js";

const READY_EXECUTION = { state: "READY_FOR_PUBLISH", errors: [] } as unknown as ExecutionReceipt;
const PUSHED = { state: "PUSHED", commit_sha: "1".repeat(40), remote_branch_sha: "1".repeat(40) } as unknown as GitPublishReceipt;
const OPEN_DRAFT = { state: "OPEN", observed_draft: true, observed_state: "open", pull_number: 31 } as unknown as DraftPullRequestReceipt;
const READY_RESULT = { state: "READY_FOR_WEB_REVIEW", archive_sha256: "a".repeat(64) } as unknown as ResultBundleReceipt;
const APPROVED = { state: "APPROVED" } as unknown as WebReviewReceipt;

test("V04-AUTO-004 retryable execution failures back off without spending completed-stage budget", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-retry-"));
  const runId = `task-retry:${"1".repeat(64)}`;
  let executeCalls = 0;
  let sleeps = 0;
  let polls = 0;
  const bridge = {
    async waitForVerdict() {
      polls += 1;
      if (polls < 4) return null;
      return { review_id: "approved" } as never;
    },
  } as unknown as WebBridge;

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
        draft: async () => OPEN_DRAFT,
        packageResult: async () => READY_RESULT,
        createFinalReview: async () => ({ job_id: "review-job" }),
        materializeVerdict: async () => ({ verdict_path: "/tmp/approve.json", receipt: APPROVED }),
        sleep: async () => { sleeps += 1; },
      },
    });

    assert.equal(executeCalls, 3);
    assert.equal(sleeps, 5); // two retry backoffs + three Web polls
    assert.equal(receipt.status, "READY_FOR_YOU");
    assert.equal(receipt.stage, "DONE");
    assert.equal(receipt.stage_attempts.EXECUTE, 0);
    assert.doesNotMatch(receipt.reason ?? "", /CYCLE_BUDGET_EXHAUSTED/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-AUTO-005 non-retryable service failures stop at NEEDS_YOU", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-terminal-"));
  try {
    const receipt = await driveAutopilotJob({
      bridge: {} as WebBridge,
      runId: `task-terminal:${"2".repeat(64)}`,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies: {
        execute: async () => { throw Object.assign(new Error("policy denied"), { code: "PATH_POLICY_VIOLATION" }); },
        sleep: async () => { throw new Error("must not retry terminal policy failure"); },
      },
    });
    assert.equal(receipt.status, "NEEDS_YOU");
    assert.equal(receipt.terminal_action, "ASK_USER_TO_INTERVENE");
    assert.match(receipt.reason ?? "", /PATH_POLICY_VIOLATION/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
