import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNextTransition, type OrchestrationDependencies } from "../src/orchestration/transition-runner.js";
import { checkpointAttempt } from "../src/orchestration/controller.js";
import { recoverCompletedAttempt } from "../src/orchestration/recovery.js";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";

const RUN_ID = `TASK-P14:${"a".repeat(64)}`;
const ARTIFACT = "b".repeat(64);
const VERDICT_SHA = "c".repeat(64);
const COMMIT = "3".repeat(40);
const DECISION_SHA = "d".repeat(64);

function snapshot(web: LifecycleSnapshot["web_review_state"] = null): LifecycleSnapshot {
  return {
    registered_artifact_sha256: ARTIFACT,
    executor_state: "READY_FOR_PUBLISH",
    publish_state: "PUSHED",
    draft_pr_state: "OPEN",
    result_bundle_ready: true,
    web_review_state: web,
    revision_state: null,
    revision_result_ready: false,
  };
}

function ingested() {
  return { canonicalBuffer: Buffer.from("{}"), verdictSha256: VERDICT_SHA, parsedVerdict: {} } as never;
}

function reviewReceipt(state: "APPROVED" | "REVISION_REQUESTED" | "ESCALATED", overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    state,
    review_round: 1,
    verdict_sha256: VERDICT_SHA,
    decision_event_sha256: DECISION_SHA,
    revision_request_sha256: state === "REVISION_REQUESTED" ? "e".repeat(64) : null,
    published_commit_sha: COMMIT,
    pull_request_number: 42,
    fresh_attested_head_sha: COMMIT,
    artifact_paths: { verdict: "web-review/verdict.json" },
    ...overrides,
  } as never;
}

function dependencies(state: LifecycleSnapshot, submit: OrchestrationDependencies["submitWebVerdict"]): OrchestrationDependencies {
  return {
    async readSnapshot() { return { ...state }; },
    async readVerdict() { return ingested(); },
    submitWebVerdict: submit,
  } as unknown as OrchestrationDependencies;
}

test("P14-ORCH-001 waiting for Web verdict is input-wait without consuming an attempt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-input-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const deps = dependencies(snapshot(), async () => { calls += 1; return reviewReceipt("APPROVED"); });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(result.needs_input, "web_verdict_path");
  assert.equal(result.progressed, false);
  assert.equal(result.ledger.transition_attempts.WAIT_WEB_VERDICT, 0);
  assert.equal(calls, 0);
});

test("P14-ORCH-002 APPROVE seals exact verdict digest and advances only to human merge authority", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-approve-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  let receivedDigest = "";
  const deps = dependencies(state, async (options) => {
    receivedDigest = options.ingestedVerdict.verdictSha256;
    state.web_review_state = "APPROVED";
    return reviewReceipt("APPROVED");
  });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), inputs: { web_verdict_path: path.join(root, "verdict.json") }, dependencies: deps });
  assert.equal(receivedDigest, VERDICT_SHA);
  assert.equal(result.progressed, true);
  assert.equal(result.planned.transition, "WAIT_HUMAN");
  assert.equal(result.ledger.last_completed_transition, "WAIT_WEB_VERDICT");
  assert.equal(result.ledger.next_transition, "WAIT_HUMAN");
  assert.equal(result.ledger.transition_attempts.WAIT_WEB_VERDICT, 1);
});

test("P14-ORCH-003 REVISE routes to revision boundary without merge prompt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-revise-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => { state.web_review_state = "REVISION_REQUESTED"; return reviewReceipt("REVISION_REQUESTED"); });
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), inputs: { web_verdict_path: path.join(root, "verdict.json") }, dependencies: deps });
  assert.equal(result.progressed, true);
  assert.equal(result.planned.transition, "REVISE");
  assert.equal(result.ledger.next_transition, "REVISE");
});

test("P14-ORCH-004 mismatched fresh GitHub head fails closed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-drift-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const state = snapshot();
  const deps = dependencies(state, async () => reviewReceipt("APPROVED", { fresh_attested_head_sha: "4".repeat(40) }));
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), inputs: { web_verdict_path: path.join(root, "verdict.json") }, dependencies: deps });
  assert.equal(result.progressed, false);
  assert.equal(result.planned.transition, "WAIT_WEB_VERDICT");
  assert.equal(result.ledger.retry.last_failure_code, "ORCHESTRATION_WEB_VERDICT_INCOMPLETE");
});

test("P14-REC-001 crash recovery revalidates a sealed Web verdict before adopting terminal decision", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p14-recover-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const verdictRelative = "review/round-1/verdict.json";
  await fs.mkdir(path.join(root, "review/round-1"), { recursive: true });
  await fs.writeFile(path.join(root, verdictRelative), "{}\n");
  const started = await checkpointAttempt({ stateDirectory: root, runId: RUN_ID, transition: "WAIT_WEB_VERDICT", payload: { verdict_sha256: VERDICT_SHA } });
  let revalidated = 0;
  const recovered = await recoverCompletedAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    configPath: path.join(root, "config.json"),
    ledger: started,
    dependencies: {
      async getWebReviewStatus() { return reviewReceipt("APPROVED", { artifact_paths: { verdict: verdictRelative } }); },
      async submitWebVerdict() { revalidated += 1; return reviewReceipt("APPROVED", { artifact_paths: { verdict: verdictRelative } }); },
    },
  });
  assert.equal(revalidated, 1);
  assert.equal(recovered.current_attempt, null);
  assert.equal(recovered.last_completed_transition, "WAIT_WEB_VERDICT");
  assert.equal(recovered.next_transition, "WAIT_HUMAN");
});
