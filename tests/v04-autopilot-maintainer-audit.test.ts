import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { autopilotReceiptPath, driveAutopilotJob, readAutopilotReceipt } from "../src/orchestration/autopilot-job.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";
import { PUSHED, READY_EXECUTION, openDraft, readyResult, webReview } from "./v04-autopilot-fixtures.js";

function approvedBridge(): WebBridge {
  return { async waitForVerdict() { return { review_id: "approved" } as never; } } as unknown as WebBridge;
}

function happyDependencies(runId: string) {
  return {
    execute: async () => READY_EXECUTION,
    publish: async () => PUSHED,
    draft: async () => openDraft(),
    packageResult: async () => readyResult(runId),
    createFinalReview: async () => ({ job_id: "review-job" }),
    materializeVerdict: async () => ({ verdict_path: "/tmp/approve.json", receipt: webReview("APPROVED", runId) }),
  };
}

test("V04-AUDIT-001 semantic-forged READY receipt is rejected fail-closed", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-semantic-"));
  const runId = `task-semantic:${"7".repeat(64)}`;
  const receiptPath = autopilotReceiptPath(stateDirectory, runId);
  try {
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify({
      schema_version: "2.0",
      mode: "AUTOPILOT",
      run_id: runId,
      generation: 1,
      status: "READY_FOR_YOU",
      stage: "EXECUTE",
      stage_attempts: { EXECUTE: 0, PUBLISH: 0, DRAFT_PR: 0, PACKAGE_RESULT: 0, WAIT_WEB: 0, REVISE: 0 },
      next_retry_at: null,
      pending_review_job_id: null,
      web_review_rounds: 1,
      revision_rounds_completed: 0,
      terminal_action: "ASK_USER_TO_MERGE",
      reason: "forged",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:00:01.000Z",
    })}\n`, { mode: 0o600 });
    await assert.rejects(readAutopilotReceipt(stateDirectory, runId), /semantic state invariants/);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});

test("V04-AUDIT-002 stale concurrent driver cannot roll durable state backward", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-concurrent-"));
  const runId = `task-concurrent:${"8".repeat(64)}`;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  try {
    const first = driveAutopilotJob({
      bridge: approvedBridge(),
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies: { execute: async () => { firstStarted(); await blocked; return READY_EXECUTION; } },
    });
    await started;
    const winner = await driveAutopilotJob({ bridge: approvedBridge(), runId, stateDirectory, configPath: path.join(stateDirectory, "config.json"), dependencies: happyDependencies(runId) });
    assert.equal(winner.status, "READY_FOR_YOU");
    const winningGeneration = winner.generation;
    releaseFirst();
    await assert.rejects(first, /AUTOPILOT_CONCURRENT_DRIVER/);
    const durable = await readAutopilotReceipt(stateDirectory, runId);
    assert.equal(durable?.status, "READY_FOR_YOU");
    assert.equal(durable?.stage, "DONE");
    assert.equal(durable?.generation, winningGeneration);
  } finally { releaseFirst?.(); await rm(stateDirectory, { recursive: true, force: true }); }
});

test("V04-AUDIT-003 mismatched Draft PR head blocks before Result Bundle packaging", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-draft-drift-"));
  const runId = `task-draft-drift:${"9".repeat(64)}`;
  let packaged = false;
  try {
    const wrong = openDraft();
    wrong.observed_head_sha = "9".repeat(40);
    const receipt = await driveAutopilotJob({
      bridge: approvedBridge(), runId, stateDirectory, configPath: path.join(stateDirectory, "config.json"),
      dependencies: { execute: async () => READY_EXECUTION, publish: async () => PUSHED, draft: async () => wrong, packageResult: async () => { packaged = true; return readyResult(runId); } },
    });
    assert.equal(packaged, false);
    assert.equal(receipt.status, "NEEDS_YOU");
    assert.equal(receipt.stage, "DRAFT_PR");
    assert.match(receipt.reason ?? "", /AUTOPILOT_DRAFT_PR_INCOMPLETE/);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});

test("V04-AUDIT-004 mismatched Result Bundle head blocks before Web final review", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-result-drift-"));
  const runId = `task-result-drift:${"a".repeat(64)}`;
  let webJob = false;
  try {
    const wrong = readyResult(runId);
    wrong.pull_request.head_sha = "9".repeat(40);
    const receipt = await driveAutopilotJob({
      bridge: approvedBridge(), runId, stateDirectory, configPath: path.join(stateDirectory, "config.json"),
      dependencies: { execute: async () => READY_EXECUTION, publish: async () => PUSHED, draft: async () => openDraft(), packageResult: async () => wrong, createFinalReview: async () => { webJob = true; return { job_id: "must-not-create" }; } },
    });
    assert.equal(webJob, false);
    assert.equal(receipt.status, "NEEDS_YOU");
    assert.equal(receipt.stage, "PACKAGE_RESULT");
    assert.match(receipt.reason ?? "", /AUTOPILOT_RESULT_INCOMPLETE/);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});

test("V04-AUDIT-005 incomplete mandatory Web APPROVE never becomes READY_FOR_YOU", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-approval-drift-"));
  const runId = `task-approval-drift:${"b".repeat(64)}`;
  try {
    const incomplete = webReview("APPROVED", runId);
    incomplete.fresh_attested_head_sha = null;
    const receipt = await driveAutopilotJob({
      bridge: approvedBridge(),
      runId,
      stateDirectory,
      configPath: path.join(stateDirectory, "config.json"),
      dependencies: { ...happyDependencies(runId), materializeVerdict: async () => ({ verdict_path: "/tmp/incomplete.json", receipt: incomplete }) },
    });
    assert.equal(receipt.status, "NEEDS_YOU");
    assert.equal(receipt.stage, "WAIT_WEB");
    assert.equal(receipt.terminal_action, "ASK_USER_TO_INTERVENE");
    assert.match(receipt.reason ?? "", /AUTOPILOT_WEB_APPROVAL_INCOMPLETE/);
  } finally { await rm(stateDirectory, { recursive: true, force: true }); }
});

test("V04-AUDIT-006 symlinked state ancestry is rejected before reading authority bytes", async () => {
  if (process.platform === "win32") return;
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-auto-symlink-state-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "wco-auto-symlink-outside-"));
  const runId = `task-symlink:${"c".repeat(64)}`;
  try {
    await symlink(outside, path.join(stateDirectory, "runs"), "dir");
    await assert.rejects(readAutopilotReceipt(stateDirectory, runId), /ancestor is not a real directory/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
