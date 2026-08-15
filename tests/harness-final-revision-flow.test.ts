import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { driveAutopilotJob } from "../src/orchestration/autopilot-job.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import { COMMIT_1, COMMIT_2, PUSHED, READY_EXECUTION, READY_REVISION, openDraft, readyResult, webReview } from "./v04-autopilot-fixtures.js";

function twoRoundBridge(): WebBridge {
  let round = 0;
  return {
    async waitForVerdict() {
      round += 1;
      return { review_id: `web-a-${round}` } as never;
    },
  } as unknown as WebBridge;
}

test("HARNESS-FINAL-REVISION-001 AUTOPILOT final Web-A repair returns to Web-A without a second execute/reviewer pass", async (t) => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wco-harness-final-revision-"));
  t.after(async () => fs.rm(stateDirectory, { recursive: true, force: true }));
  const runId = `harness-final-revision:${"9".repeat(64)}`;
  let executeCalls = 0;
  let reviseCalls = 0;
  let finalReviewJobs = 0;
  let verdicts = 0;

  const receipt = await driveAutopilotJob({
    bridge: twoRoundBridge(),
    runId,
    stateDirectory,
    configPath: path.join(stateDirectory, "config.json"),
    maxCycles: 16,
    dependencies: {
      execute: async () => { executeCalls += 1; return READY_EXECUTION; },
      publish: async () => PUSHED,
      draft: async () => openDraft(COMMIT_1),
      packageResult: async () => readyResult(runId, COMMIT_1),
      createFinalReview: async () => { finalReviewJobs += 1; return { job_id: `final-${finalReviewJobs}` }; },
      materializeVerdict: async () => {
        verdicts += 1;
        return verdicts === 1
          ? { verdict_path: "/tmp/revise.json", receipt: webReview("REVISION_REQUESTED", runId, COMMIT_1) }
          : { verdict_path: "/tmp/approve.json", receipt: webReview("APPROVED", runId, COMMIT_2) };
      },
      attestRevision: async () => ({ revisionRound: 1 }),
      revise: async () => { reviseCalls += 1; return READY_REVISION; },
      revalidateReady: async () => webReview("APPROVED", runId, COMMIT_2),
      sleep: async () => undefined,
    },
  });

  assert.equal(receipt.status, "READY_FOR_YOU");
  assert.equal(receipt.stage, "DONE");
  assert.equal(receipt.web_review_rounds, 2);
  assert.equal(receipt.revision_rounds_completed, 1);
  assert.equal(executeCalls, 1, "the initial selected reviewer/execution stage must not run again after final Web-A repair");
  assert.equal(reviseCalls, 1, "the sealed final Web-A repair is promoted exactly once");
  assert.equal(finalReviewJobs, 2, "the repaired Result generation must return to original Web-A for a new final review");
});
