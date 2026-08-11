import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_REVIEWER, parseReviewerSelection, type ReviewerSelection } from "../src/agent/reviewer-selection.js";
import { effectiveRunReviewMode, freezeRunReviewMode, readReviewMode, readRunReviewMode, runReviewModePath, writeReviewMode } from "../src/agent/reviewer-mode-store.js";
import { driveAutopilotJob } from "../src/orchestration/autopilot-job.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import { PUSHED, READY_EXECUTION, openDraft, readyResult, webReview } from "./v04-autopilot-fixtures.js";

async function prepareRunDirectory(stateDirectory: string, runId: string): Promise<void> {
  const separator = runId.lastIndexOf(":");
  await mkdir(path.join(stateDirectory, "runs", runId.slice(0, separator), runId.slice(separator + 1)), { recursive: true });
}

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
    await prepareRunDirectory(stateDirectory, runId);
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

test("V04-MODE-004 missing frozen reviewer fails closed instead of inheriting mutable global /mode", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-review-mode-missing-"));
  const runId = `task-review-missing:${"f".repeat(64)}`;
  try {
    await prepareRunDirectory(stateDirectory, runId);
    const sol = parseReviewerSelection("sol", "high");
    const terra = parseReviewerSelection("terra", "xhigh");
    await freezeRunReviewMode(stateDirectory, runId, sol);
    await writeReviewMode(stateDirectory, terra);
    await rm(runReviewModePath(stateDirectory, runId));
    assert.deepEqual(await readReviewMode(stateDirectory), terra);
    await assert.rejects(effectiveRunReviewMode(stateDirectory, runId), /REVIEW_MODE_RUN_MISSING/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-MODE-005 concurrent different reviewer freezes cannot overwrite each other", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-review-mode-race-"));
  const runId = `task-review-race:${"1".repeat(64)}`;
  try {
    await prepareRunDirectory(stateDirectory, runId);
    const candidates = [parseReviewerSelection("sol", "high"), parseReviewerSelection("terra", "xhigh")] as const;
    const results = await Promise.allSettled(candidates.map(async (selection) => await freezeRunReviewMode(stateDirectory, runId, selection)));
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<ReviewerSelection> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /REVIEW_MODE_RUN_DRIFT/);
    assert.deepEqual(await effectiveRunReviewMode(stateDirectory, runId), fulfilled[0]!.value);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("V04-MODE-006 frozen reviewer authority rejects symlinked file and ancestor paths", async () => {
  if (process.platform === "win32") return;
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-review-mode-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "wco-review-mode-outside-"));
  const runId = `task-review-symlink:${"2".repeat(64)}`;
  try {
    await prepareRunDirectory(stateDirectory, runId);
    await symlink(path.join(outside, "missing.json"), runReviewModePath(stateDirectory, runId));
    await assert.rejects(readRunReviewMode(stateDirectory, runId), /REVIEW_MODE_UNSAFE/);

    const stateWithSymlinkedRuns = await mkdtemp(path.join(os.tmpdir(), "wco-review-mode-parent-"));
    try {
      await symlink(outside, path.join(stateWithSymlinkedRuns, "runs"), "dir");
      await assert.rejects(effectiveRunReviewMode(stateWithSymlinkedRuns, runId), /REVIEW_MODE_UNSAFE/);
    } finally {
      await rm(stateWithSymlinkedRuns, { recursive: true, force: true });
    }
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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
