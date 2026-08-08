import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkpointAttempt } from "../src/orchestration/controller.js";
import { recoverCompletedAttempt } from "../src/orchestration/recovery.js";
import { revisionOrchestrationPayload, type RevisionOrchestrationAuthority } from "../src/orchestration/revise.js";
import { runNextTransition, type OrchestrationDependencies } from "../src/orchestration/transition-runner.js";
import { readRunLedger } from "../src/orchestration/ledger.js";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";

const RUN_ID = `TASK-P15:${"a".repeat(64)}`;
const ARTIFACT = "b".repeat(64);
const VERDICT = "c".repeat(64);
const REQUEST = "d".repeat(64);
const RESULT = "e".repeat(64);
const MANIFEST = "f".repeat(64);
const DECISION = "1".repeat(64);
const OLD_HEAD = "3".repeat(40);
const NEW_HEAD = "4".repeat(40);

function snapshot(): LifecycleSnapshot {
  return {
    registered_artifact_sha256: ARTIFACT,
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: true,
    web_review_state: "REVISION_REQUESTED",
    revision_state: null,
    revision_result_ready: false,
  };
}

function webReview() {
  return {
    run_id: RUN_ID,
    state: "REVISION_REQUESTED",
    review_round: 1,
    verdict_sha256: VERDICT,
    revision_request_sha256: REQUEST,
    decision_event_sha256: DECISION,
    published_commit_sha: OLD_HEAD,
    pull_request_number: 42,
    fresh_attested_head_sha: OLD_HEAD,
  } as const;
}

function authority(overrides: Partial<RevisionOrchestrationAuthority> = {}): RevisionOrchestrationAuthority {
  return {
    revisionRound: 1,
    revisionRequestSha256: REQUEST,
    verdictSha256: VERDICT,
    decisionEventSha256: DECISION,
    publishedCommitSha: OLD_HEAD,
    pullRequestNumber: 42,
    freshAttestedHeadSha: OLD_HEAD,
    ...overrides,
  };
}

function revisionReceipt(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    revision_round: 1,
    state: "RESULT_READY",
    previous_verdict_sha256: VERDICT,
    revision_request_sha256: REQUEST,
    previous_pr_head_sha: OLD_HEAD,
    pull_request_number: 42,
    new_published_commit_sha: NEW_HEAD,
    remote_branch_sha: NEW_HEAD,
    result_bundle_sha256: RESULT,
    result_manifest_sha256: MANIFEST,
    next_review_round: 2,
    usage: { total_turns: 3, input_tokens: 1200, output_tokens: 300 },
    ...overrides,
  } as never;
}

function dependencies(state: LifecycleSnapshot, revise: OrchestrationDependencies["reviseRun"]): OrchestrationDependencies {
  return {
    async readSnapshot() { return { ...state }; },
    async readWebReview() { return webReview() as never; },
    reviseRun: revise,
  } as unknown as OrchestrationDependencies;
}

test("P15-ORCH-001 sealed revision authority executes once and advances to the next Web verdict", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-revise-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  let calls = 0;
  const deps = dependencies(state, async (options) => {
    calls += 1;
    assert.equal(options.revisionRound, 1);
    state.revision_state = "RESULT_READY";
    state.revision_result_ready = true;
    return revisionReceipt();
  });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(calls, 1);
  assert.equal(result.progressed, true);
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(result.ledger.last_completed_transition, "REVISE");
  assert.equal(result.ledger.next_transition, "WAIT_WEB_VERDICT");
  assert.equal(result.ledger.transition_attempts.REVISE, 1);
  assert.equal(result.ledger.budget.model_turns, 3);
  assert.equal(result.ledger.budget.input_tokens, 1200);
  assert.equal(result.ledger.budget.output_tokens, 300);
});

test("P15-ORCH-002 publication or same-PR drift fails closed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-drift-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => revisionReceipt({ remote_branch_sha: "5".repeat(40) }));
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "REVISE");
  assert.equal(result.ledger.retry.last_failure_code, "ORCHESTRATION_REVISION_INCOMPLETE");
});

test("P15-ORCH-003 completed revision is quiescent and consumes no extra model turn", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-ready-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  state.revision_state = "RESULT_READY";
  state.revision_result_ready = true;
  let calls = 0;
  const deps = dependencies(state, async () => { calls += 1; return revisionReceipt(); });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.progressed, false);
  assert.equal(result.needs_input, "web_verdict_path");
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(calls, 0);
  assert.equal(result.ledger.transition_attempts.REVISE, 0);
});

test("P15-ORCH-004 revision is limited to Web review rounds 1 through 3 before an attempt is consumed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-round-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => revisionReceipt());
  deps.readWebReview = async () => ({ ...webReview(), review_round: 4 } as never);
  await assert.rejects(
    runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps }),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ORCHESTRATION_REVISION_AUTHORITY_INVALID",
  );
  const ledger = await readRunLedger(root, RUN_ID);
  assert.equal(ledger?.transition_attempts.REVISE, 0);
});

test("P15-REC-001 completed RESULT_READY revision is adopted after restart and usage is counted exactly once", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-rec-ready-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sealed = authority();
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "REVISE",
    payload: revisionOrchestrationPayload(sealed),
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  let terminalRevalidations = 0;
  const recovered = await recoverCompletedAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    configPath: path.join(root, "config.json"),
    ledger: started,
    dependencies: {
      async attestRevisionAuthority() { return sealed; },
      async getRevisionStatus() { return revisionReceipt(); },
      async reviseRun() { terminalRevalidations += 1; return revisionReceipt(); },
    },
    now: () => new Date("2026-08-08T00:00:01.000Z"),
  });
  assert.equal(terminalRevalidations, 1);
  assert.equal(recovered.current_attempt, null);
  assert.equal(recovered.transition_attempts.REVISE, 1);
  assert.equal(recovered.last_completed_transition, "REVISE");
  assert.equal(recovered.next_transition, "WAIT_WEB_VERDICT");
  assert.equal(recovered.budget.model_turns, 3);
  assert.equal(recovered.budget.input_tokens, 1200);
  assert.equal(recovered.budget.output_tokens, 300);

  const reread = await readRunLedger(root, RUN_ID);
  assert.equal(reread?.budget.model_turns, 3);
  assert.equal(reread?.budget.input_tokens, 1200);
  assert.equal(reread?.budget.output_tokens, 300);
});

test("P15-REC-002 changed revision authority is rejected before terminal revision adoption", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p15-rec-conflict-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sealed = authority();
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "REVISE",
    payload: revisionOrchestrationPayload(sealed),
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  let statusReads = 0;
  await assert.rejects(
    () => recoverCompletedAttempt({
      stateDirectory: root,
      runId: RUN_ID,
      configPath: path.join(root, "config.json"),
      ledger: started,
      dependencies: {
        async attestRevisionAuthority() { return authority({ decisionEventSha256: "2".repeat(64) }); },
        async getRevisionStatus() { statusReads += 1; return revisionReceipt(); },
      },
    }),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ORCHESTRATION_RECOVERY_CONFLICT",
  );
  assert.equal(statusReads, 0);
});
