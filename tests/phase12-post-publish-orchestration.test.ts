import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNextTransition, type OrchestrationDependencies } from "../src/orchestration/transition-runner.js";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";

const RUN_ID = `TASK-P12:${"a".repeat(64)}`;
const ARTIFACT = "b".repeat(64);
const MANIFEST = "c".repeat(64);
const DIGEST = "d".repeat(64);
const COMMIT = "3".repeat(40);

function registration() {
  return { artifact_sha256: ARTIFACT, manifest_sha256: MANIFEST } as never;
}

function snapshot(): LifecycleSnapshot {
  return {
    registered_artifact_sha256: ARTIFACT,
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: null,
    result_bundle_ready: false,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };
}

function openReceipt(overrides: Record<string, unknown> = {}) {
  return {
    state: "OPEN",
    observed_draft: true,
    observed_state: "open",
    observed_head_sha: COMMIT,
    expected_head_sha: COMMIT,
    pull_number: 42,
    request_sha256: "e".repeat(64),
    ...overrides,
  } as never;
}

function dependencies(state: LifecycleSnapshot, openDraftPr: OrchestrationDependencies["openDraftPr"]): OrchestrationDependencies {
  return {
    async readSnapshot() { return { ...state }; },
    async readSelectedArtifact() { return registration(); },
    async attestReadyExecutor() { return { changeSetDigest: DIGEST } as never; },
    openDraftPr,
  } as unknown as OrchestrationDependencies;
}

test("P12-ORCH-001 OPEN_DRAFT_PR is checkpointed once and advances only after an exact open Draft receipt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p12-open-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  let calls = 0;
  const deps = dependencies(state, async () => {
    calls += 1;
    state.draft_pr_state = "OPEN";
    return openReceipt();
  });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(calls, 1);
  assert.equal(result.progressed, true);
  assert.equal(result.planned.transition, "PACKAGE_RESULT");
  assert.equal(result.ledger.transition_attempts.OPEN_DRAFT_PR, 1);
  assert.equal(result.ledger.last_completed_transition, "OPEN_DRAFT_PR");
  assert.equal(result.ledger.current_attempt, null);
  assert.equal(result.ledger.next_transition, "PACKAGE_RESULT");
  assert.equal(result.ledger.retry.last_failure_code, null);
});

test("P12-ORCH-002 non-Draft or mismatched GitHub result fails closed and does not advance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p12-fail-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => openReceipt({ observed_draft: false }));
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "OPEN_DRAFT_PR");
  assert.equal(result.ledger.transition_attempts.OPEN_DRAFT_PR, 1);
  assert.equal(result.ledger.current_attempt, null);
  assert.equal(result.ledger.retry.last_failure_code, "ORCHESTRATION_DRAFT_PR_INCOMPLETE");
  assert.equal(result.ledger.diagnostics.at(-1)?.code, "ORCHESTRATION_DRAFT_PR_INCOMPLETE");
});

test("P12-ORCH-003 PACKAGE_RESULT remains a boundary until Phase 13 and never repeats Draft PR creation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p12-boundary-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  state.draft_pr_state = "OPEN";
  let calls = 0;
  const deps = dependencies(state, async () => { calls += 1; return openReceipt(); });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "PACKAGE_RESULT");
  assert.equal(calls, 0);
  assert.equal(result.ledger.transition_attempts.OPEN_DRAFT_PR, 0);
});
