import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { driveAutopilotJob } from "../src/orchestration/autopilot-job.js";
import { deriveNextTransition, type LifecycleSnapshot } from "../src/orchestration/planner.js";
import type { ContinueResult } from "../src/orchestration/transition-runner.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";

const activeLedger = {
  status: "ACTIVE",
  retry: { next_retry_at: null },
} as unknown as ContinueResult["ledger"];

function waitingLedger(): ContinueResult["ledger"] {
  return {
    status: "WAITING",
    retry: { next_retry_at: "2030-01-01T00:00:01.000Z" },
  } as unknown as ContinueResult["ledger"];
}

test("V04-AUTO-004 retryable REGISTER waits do not spend progress cycles or require the user", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-retry-"));
  const runId = `task-retry:${"1".repeat(64)}`;
  let calls = 0;
  let sleeps = 0;
  let snapshot: LifecycleSnapshot = {
    registered_artifact_sha256: null,
    executor_state: null,
    publish_state: null,
    draft_pr_state: null,
    result_bundle_ready: false,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };

  try {
    const receipt = await driveAutopilotJob({
      bridge: {} as WebBridge,
      runId,
      webPackPath: path.join(stateDirectory, "web-pack.zip"),
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      maxCycles: 1,
      now: () => new Date("2029-12-31T23:59:59.000Z"),
      dependencies: {
        readSnapshot: async () => snapshot,
        deriveNext: deriveNextTransition,
        runNext: async () => {
          calls += 1;
          if (calls < 3) {
            return {
              ledger: waitingLedger(),
              planned: deriveNextTransition(snapshot),
              progressed: false,
              needs_input: null,
            };
          }
          snapshot = {
            registered_artifact_sha256: "2".repeat(64),
            executor_state: "READY_FOR_PUBLISH",
            publish_state: "PUSHED",
            draft_pr_state: "OPEN",
            result_bundle_ready: true,
            web_review_state: "APPROVED",
            revision_state: null,
            revision_result_ready: false,
          };
          return {
            ledger: activeLedger,
            planned: deriveNextTransition(snapshot),
            progressed: true,
            needs_input: null,
          };
        },
        sleep: async () => { sleeps += 1; },
      },
    });

    assert.equal(calls, 3);
    assert.equal(sleeps, 2);
    assert.equal(receipt.status, "READY_FOR_YOU");
    assert.equal(receipt.terminal_action, "ASK_USER_TO_MERGE");
    assert.doesNotMatch(receipt.reason ?? "", /CYCLE_BUDGET_EXHAUSTED/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
