import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNextTransition, type OrchestrationDependencies } from "../src/orchestration/transition-runner.js";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";

const RUN_ID = `TASK-P13:${"a".repeat(64)}`;
const ARTIFACT = "b".repeat(64);
const DIGEST = "d".repeat(64);
const ARCHIVE = "e".repeat(64);
const REVIEWED = "f".repeat(64);
const COMMIT = "3".repeat(40);

function snapshot(): LifecycleSnapshot {
  return {
    registered_artifact_sha256: ARTIFACT,
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: false,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };
}

function resultReceipt(overrides: Record<string, unknown> = {}) {
  return {
    state: "READY_FOR_WEB_REVIEW",
    run_id: RUN_ID,
    archive_sha256: ARCHIVE,
    published_commit_sha: COMMIT,
    remote_branch_sha: COMMIT,
    reviewed_entry_set_sha256: REVIEWED,
    pull_request: { number: 42, draft: true, head_sha: COMMIT },
    ...overrides,
  } as never;
}

function dependencies(state: LifecycleSnapshot, packageResult: OrchestrationDependencies["packageResult"]): OrchestrationDependencies {
  return {
    async readSnapshot() { return { ...state }; },
    async readSelectedArtifact() { return { artifact_sha256: ARTIFACT, manifest_sha256: "c".repeat(64) } as never; },
    async attestReadyExecutor() { return { changeSetDigest: DIGEST } as never; },
    packageResult,
  } as unknown as OrchestrationDependencies;
}

test("P13-ORCH-001 PACKAGE_RESULT is durably checkpointed and advances only after an exact verified handoff", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p13-package-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  let calls = 0;
  const deps = dependencies(state, async () => {
    calls += 1;
    state.result_bundle_ready = true;
    return resultReceipt();
  });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(calls, 1);
  assert.equal(result.progressed, true);
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(result.ledger.transition_attempts.PACKAGE_RESULT, 1);
  assert.equal(result.ledger.last_completed_transition, "PACKAGE_RESULT");
  assert.equal(result.ledger.current_attempt, null);
  assert.equal(result.ledger.next_transition, "WAIT_WEB_VERDICT");
});

test("P13-ORCH-002 wrong PR head fails closed and preserves the packaging boundary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p13-fail-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => resultReceipt({ pull_request: { number: 42, draft: true, head_sha: "4".repeat(40) } }));
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "PACKAGE_RESULT");
  assert.equal(result.ledger.transition_attempts.PACKAGE_RESULT, 1);
  assert.equal(result.ledger.retry.last_failure_code, "ORCHESTRATION_RESULT_INCOMPLETE");
});

test("P13-ORCH-003 READY_FOR_WEB_REVIEW is quiescent and does not repackage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p13-wait-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  state.result_bundle_ready = true;
  let calls = 0;
  const deps = dependencies(state, async () => { calls += 1; return resultReceipt(); });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(calls, 0);
  assert.equal(result.ledger.transition_attempts.PACKAGE_RESULT, 0);
});
