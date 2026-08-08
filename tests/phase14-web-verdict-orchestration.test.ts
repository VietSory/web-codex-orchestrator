import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkpointAttempt } from "../src/orchestration/controller.js";
import { sealTransitionRequest } from "../src/orchestration/retry-policy.js";
import { runNextTransition, type OrchestrationDependencies } from "../src/orchestration/transition-runner.js";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";
import {
  prepareWebVerdictForRun,
  recoverPreparedWebVerdictForAttempt,
} from "../src/orchestration/web-verdict.js";
import { recoverCompletedWebVerdictAttempt } from "../src/orchestration/web-verdict-recovery.js";

const RUN_ID = `TASK-P14:${"a".repeat(64)}`;
const ARTIFACT = "b".repeat(64);
const VERDICT = "c".repeat(64);
const RESULT = "d".repeat(64);
const DECISION = "e".repeat(64);
const REVISION = "f".repeat(64);
const COMMIT = "3".repeat(40);

function snapshot(): LifecycleSnapshot {
  return {
    registered_artifact_sha256: ARTIFACT,
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: true,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };
}

function reviewReceipt(state: "APPROVED" | "REVISION_REQUESTED" | "ESCALATED", overrides: Record<string, unknown> = {}) {
  return {
    phase_version: "1.1",
    run_id: RUN_ID,
    review_mode: "INITIAL",
    review_round: 1,
    state,
    phase6_receipt_sha256: "1".repeat(64),
    result_bundle_sha256: RESULT,
    manifest_sha256: "2".repeat(64),
    reviewed_entry_set_sha256: "4".repeat(64),
    spec_set_sha256: "5".repeat(64),
    verdict_sha256: VERDICT,
    published_commit_sha: COMMIT,
    pull_request_number: 42,
    observed_head_sha: COMMIT,
    fresh_attested_head_sha: COMMIT,
    fresh_attested_base_branch: "main",
    previous_result_bundle_sha256: null,
    previous_verdict_sha256: null,
    previous_published_commit_sha: null,
    previous_pr_head_sha: null,
    revision_request_sha256: state === "REVISION_REQUESTED" ? REVISION : null,
    decision_event_sha256: DECISION,
    action: state === "APPROVED" ? "ASK_USER_TO_MERGE" : state === "REVISION_REQUESTED" ? "NO_USER_MERGE_PROMPT" : "NOTIFY_USER_EXCEPTION",
    artifact_paths: { verdict: "v", receipt: "r", decision_event: "d", revision_request: state === "REVISION_REQUESTED" ? "x" : null, lock: "l" },
    warnings: [],
    errors: [],
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:01.000Z",
    validated_at: "2026-08-08T00:00:01.000Z",
    completed_at: "2026-08-08T00:00:01.000Z",
    ...overrides,
  } as never;
}

function dependencies(state: LifecycleSnapshot, submit: OrchestrationDependencies["submitWebVerdict"]): OrchestrationDependencies {
  return {
    async readSnapshot() { return { ...state }; },
    async prepareWebVerdict() { return { verdictPath: "/staged/verdict.json", verdictSha256: VERDICT, reviewRound: 1 }; },
    async recoverPreparedWebVerdict() { return null; },
    async recoverRetryableWebVerdict() { return null; },
    submitWebVerdict: submit,
  } as unknown as OrchestrationDependencies;
}

test("P14-ORCH-001 WAIT_WEB_VERDICT is quiescent until a verdict input exists", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-wait-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  let submitCalls = 0;
  const deps = dependencies(state, async () => { submitCalls += 1; return reviewReceipt("APPROVED"); });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(result.needs_input, "verdict_path");
  assert.equal(result.ledger.transition_attempts.WAIT_WEB_VERDICT, 0);
  assert.equal(submitCalls, 0);
});

test("P14-ORCH-002 exact APPROVED verdict advances only to human merge authority", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-approve-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => {
    state.web_review_state = "APPROVED";
    return reviewReceipt("APPROVED");
  });
  const result = await runNextTransition({
    runId: RUN_ID,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    inputs: { verdict_path: path.join(root, "incoming.json") },
    dependencies: deps,
  });
  assert.equal(result.progressed, true);
  assert.equal(result.planned.transition, "WAIT_HUMAN");
  assert.equal(result.ledger.last_completed_transition, "WAIT_WEB_VERDICT");
  assert.equal(result.ledger.next_transition, "WAIT_HUMAN");
  assert.equal(result.ledger.transition_attempts.WAIT_WEB_VERDICT, 1);
  assert.equal(result.ledger.current_attempt, null);
});

test("P14-ORCH-003 exact REVISION_REQUESTED verdict advances to the sealed revision boundary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-revise-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => {
    state.web_review_state = "REVISION_REQUESTED";
    return reviewReceipt("REVISION_REQUESTED");
  });
  const result = await runNextTransition({
    runId: RUN_ID,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    inputs: { verdict_path: path.join(root, "incoming.json") },
    dependencies: deps,
  });
  assert.equal(result.progressed, true);
  assert.equal(result.planned.transition, "REVISE");
  assert.equal(result.ledger.next_transition, "REVISE");
  assert.equal(result.ledger.transition_attempts.WAIT_WEB_VERDICT, 1);
});

test("P14-ORCH-004 stale fresh PR head fails closed at the verdict boundary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-stale-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => reviewReceipt("APPROVED", { fresh_attested_head_sha: "4".repeat(40) }));
  const result = await runNextTransition({
    runId: RUN_ID,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    inputs: { verdict_path: path.join(root, "incoming.json") },
    dependencies: deps,
  });
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(result.ledger.retry.last_failure_code, "ORCHESTRATION_VERDICT_INCOMPLETE");
  assert.equal(result.ledger.transition_attempts.WAIT_WEB_VERDICT, 1);
});

test("P14-RECOVERY-001 a terminal receipt adopts the exact sealed in-flight verdict attempt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-recovery-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const startedAt = new Date("2026-08-08T00:00:00.000Z");
  const ledger = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "WAIT_WEB_VERDICT",
    payload: { verdict_sha256: VERDICT, review_round: 1 },
    now: startedAt,
  });
  const recovered = await recoverCompletedWebVerdictAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    ledger,
    now: () => new Date("2026-08-08T00:00:02.000Z"),
    dependencies: {
      async getStatus() { return reviewReceipt("APPROVED"); },
    },
  });
  assert.equal(recovered.current_attempt, null);
  assert.equal(recovered.last_completed_transition, "WAIT_WEB_VERDICT");
  assert.equal(recovered.next_transition, "WAIT_HUMAN");
});

test("P14-RECOVERY-002 resumed verdict drift is rejected before overwriting the sealed staged input", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-stage-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const firstPath = path.join(root, "first.json");
  const secondPath = path.join(root, "second.json");
  await fs.writeFile(firstPath, JSON.stringify({ review_round: 1, marker: "first" }));
  await fs.writeFile(secondPath, JSON.stringify({ review_round: 1, marker: "second" }));
  const first = await prepareWebVerdictForRun({ runId: RUN_ID, stateDirectory: root, verdictPath: firstPath });
  const sealed = sealTransitionRequest("WAIT_WEB_VERDICT", { verdict_sha256: first.verdictSha256, review_round: 1 });
  await assert.rejects(
    prepareWebVerdictForRun({ runId: RUN_ID, stateDirectory: root, verdictPath: secondPath, expectedRequestSha256: sealed }),
    (error: unknown) => (error as { code?: string }).code === "ORCHESTRATION_ATTEMPT_CONFLICT",
  );
  const recovered = await recoverPreparedWebVerdictForAttempt({ runId: RUN_ID, stateDirectory: root, requestSha256: sealed });
  assert.equal(recovered?.verdictSha256, first.verdictSha256);
});
