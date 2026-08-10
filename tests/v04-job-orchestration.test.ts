import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { driveAutopilotJob, readAutopilotReceipt, type AutopilotDependencies } from "../src/orchestration/autopilot-job.js";
import { driveJob } from "../src/orchestration/job-orchestrator.js";
import { parseJobMode } from "../src/orchestration/job-mode.js";
import { deriveNextTransition, type LifecycleSnapshot, type PlannedTransition } from "../src/orchestration/planner.js";
import type { ContinueResult } from "../src/orchestration/transition-runner.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import type { WebReviewReceipt } from "../src/web-review/contracts.js";

function baseSnapshot(): LifecycleSnapshot {
  return {
    registered_artifact_sha256: null,
    executor_state: null,
    publish_state: null,
    draft_pr_state: null,
    result_bundle_ready: false,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };
}

function progressed(plan: PlannedTransition): ContinueResult {
  return {
    ledger: { status: "ACTIVE", retry: { next_retry_at: null } } as unknown as ContinueResult["ledger"],
    planned: plan,
    progressed: true,
    needs_input: null,
  };
}

test("V04-MODE-001 PAIR is the default and never silently enters AUTOPILOT", async () => {
  assert.equal(parseJobMode(undefined), "PAIR");
  assert.equal(parseJobMode("autopilot"), "AUTOPILOT");
  assert.throws(() => parseJobMode("unguarded"), /JOB_MODE_INVALID/);

  let touchedAutopilot = false;
  const result = await driveJob({
    bridge: {} as WebBridge,
    runId: "not-needed-in-pair",
    webPackPath: "not-needed-in-pair",
    stateDirectory: "not-needed-in-pair",
    configPath: "not-needed-in-pair",
    dependencies: {
      readSnapshot: async () => {
        touchedAutopilot = true;
        return baseSnapshot();
      },
    },
  });

  assert.equal(result.mode, "PAIR");
  assert.equal(result.status, "INTERACTIVE");
  assert.equal(touchedAutopilot, false);
});

test("V04-AUTO-001 AUTOPILOT owns the post-handoff lifecycle through revision and approved Draft PR", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-"));
  const runId = `task-auto:${"a".repeat(64)}`;
  let snapshot = baseSnapshot();
  const transitions: string[] = [];
  let reviewJobs = 0;
  let verdicts = 0;

  const bridge = {
    async waitForVerdict() {
      verdicts += 1;
      return { review_id: `review-${verdicts}` } as never;
    },
  } as unknown as WebBridge;

  const dependencies: Partial<AutopilotDependencies> = {
    readSnapshot: async () => snapshot,
    deriveNext: deriveNextTransition,
    runNext: async () => {
      const plan = deriveNextTransition(snapshot);
      transitions.push(plan.transition);
      if (plan.transition === "REGISTER_WEB_PACK") {
        snapshot = { ...snapshot, registered_artifact_sha256: "b".repeat(64), executor_state: "APPLIED" };
      } else if (plan.transition === "EXECUTE_REGISTERED_PACK") {
        snapshot = { ...snapshot, executor_state: "READY_FOR_PUBLISH" };
      } else if (plan.transition === "PUBLISH") {
        snapshot = { ...snapshot, publish_state: "PUSHED" };
      } else if (plan.transition === "OPEN_DRAFT_PR") {
        snapshot = { ...snapshot, draft_pr_state: "OPEN" };
      } else if (plan.transition === "PACKAGE_RESULT") {
        snapshot = { ...snapshot, result_bundle_ready: true, web_review_state: "PENDING" };
      } else if (plan.transition === "REVISE") {
        snapshot = { ...snapshot, revision_state: "RESULT_READY", revision_result_ready: true, result_bundle_ready: true };
      } else {
        throw new Error(`unexpected transition ${plan.transition}`);
      }
      return progressed(plan);
    },
    createFinalReview: async () => ({ job_id: `review-${++reviewJobs}` }) as never,
    materializeVerdict: async () => {
      if (verdicts === 1) {
        snapshot = { ...snapshot, web_review_state: "REVISION_REQUESTED", revision_state: null, revision_result_ready: false };
        return { verdict_path: "/tmp/revise.json", receipt: { state: "REVISION_REQUESTED" } as WebReviewReceipt };
      }
      snapshot = { ...snapshot, web_review_state: "APPROVED" };
      return { verdict_path: "/tmp/approve.json", receipt: { state: "APPROVED" } as WebReviewReceipt };
    },
    sleep: async () => undefined,
  };

  try {
    const receipt = await driveAutopilotJob({
      bridge,
      runId,
      webPackPath: path.join(stateDirectory, "web-pack.zip"),
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies,
      maxCycles: 32,
    });

    assert.equal(receipt.status, "READY_FOR_YOU");
    assert.equal(receipt.terminal_action, "ASK_USER_TO_MERGE");
    assert.equal(receipt.web_review_rounds, 2);
    assert.equal(reviewJobs, 2);
    assert.deepEqual(transitions, [
      "REGISTER_WEB_PACK",
      "EXECUTE_REGISTERED_PACK",
      "PUBLISH",
      "OPEN_DRAFT_PR",
      "PACKAGE_RESULT",
      "REVISE",
    ]);
    const durable = await readAutopilotReceipt(stateDirectory, runId);
    assert.equal(durable?.status, "READY_FOR_YOU");
    assert.equal(durable?.terminal_action, "ASK_USER_TO_MERGE");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-AUTO-002 waiting for Web does not consume progressing-cycle budget", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-wait-"));
  const runId = `task-wait:${"c".repeat(64)}`;
  let polls = 0;
  let snapshot: LifecycleSnapshot = {
    ...baseSnapshot(),
    registered_artifact_sha256: "d".repeat(64),
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: true,
    web_review_state: "PENDING",
  };
  const bridge = {
    async waitForVerdict() {
      polls += 1;
      if (polls < 4) return null;
      return { review_id: "review-wait" } as never;
    },
  } as unknown as WebBridge;

  try {
    const receipt = await driveAutopilotJob({
      bridge,
      runId,
      webPackPath: path.join(stateDirectory, "web-pack.zip"),
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      maxCycles: 1,
      dependencies: {
        readSnapshot: async () => snapshot,
        deriveNext: deriveNextTransition,
        createFinalReview: async () => ({ job_id: "review-wait" }) as never,
        materializeVerdict: async () => {
          snapshot = { ...snapshot, web_review_state: "APPROVED" };
          return { verdict_path: "/tmp/approve.json", receipt: { state: "APPROVED" } as WebReviewReceipt };
        },
        sleep: async () => undefined,
      },
    });
    assert.equal(polls, 4);
    assert.equal(receipt.status, "READY_FOR_YOU");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-AUTO-003 replan requires a fresh Web pack instead of replaying stale authority", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-replan-"));
  const runId = `task-replan:${"e".repeat(64)}`;
  const snapshot: LifecycleSnapshot = {
    ...baseSnapshot(),
    registered_artifact_sha256: "f".repeat(64),
    executor_state: "ESCALATE_TO_WEB",
  };
  let executed = false;

  try {
    const receipt = await driveAutopilotJob({
      bridge: {} as WebBridge,
      runId,
      webPackPath: path.join(stateDirectory, "old-pack.zip"),
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies: {
        readSnapshot: async () => snapshot,
        deriveNext: deriveNextTransition,
        runNext: async () => {
          executed = true;
          throw new Error("must not run");
        },
      },
    });
    assert.equal(executed, false);
    assert.equal(receipt.status, "NEEDS_YOU");
    assert.equal(receipt.terminal_action, "ASK_USER_TO_INTERVENE");
    assert.match(receipt.reason ?? "", /new implementation pack/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
