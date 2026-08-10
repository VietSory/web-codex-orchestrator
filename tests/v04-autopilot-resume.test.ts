import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { driveAutopilotJob } from "../src/orchestration/autopilot-job.js";
import { deriveNextTransition, type LifecycleSnapshot } from "../src/orchestration/planner.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";

test("V04-AUTO-005 durable resume reuses the sealed pack binding", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-resume-"));
  const runId = `task-resume:${"3".repeat(64)}`;
  const packPath = path.join(stateDirectory, "sealed-web-pack.zip");
  const controller = new AbortController();
  controller.abort();

  try {
    const paused = await driveAutopilotJob({
      bridge: {} as WebBridge,
      runId,
      webPackPath: packPath,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      signal: controller.signal,
      dependencies: {
        readSnapshot: async () => { throw new Error("aborted job must not read lifecycle state"); },
      },
    });
    assert.equal(paused.status, "PAUSED");
    assert.equal(paused.web_pack_path, path.resolve(packPath));

    const approved: LifecycleSnapshot = {
      registered_artifact_sha256: "4".repeat(64),
      executor_state: "READY_FOR_PUBLISH",
      publish_state: "PUSHED",
      draft_pr_state: "OPEN",
      result_bundle_ready: true,
      web_review_state: "APPROVED",
      revision_state: null,
      revision_result_ready: false,
    };
    const resumed = await driveAutopilotJob({
      bridge: {} as WebBridge,
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies: {
        readSnapshot: async () => approved,
        deriveNext: deriveNextTransition,
      },
    });
    assert.equal(resumed.status, "READY_FOR_YOU");
    assert.equal(resumed.terminal_action, "ASK_USER_TO_MERGE");
    assert.equal(resumed.web_pack_path, path.resolve(packPath));
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-AUTO-006 first drive fails closed without a sealed Web pack", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-first-"));
  try {
    await assert.rejects(
      driveAutopilotJob({
        bridge: {} as WebBridge,
        runId: `task-first:${"5".repeat(64)}`,
        stateDirectory,
        configPath: path.join(stateDirectory, "config.json"),
      }),
      /AUTOPILOT_PACK_REQUIRED/,
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
