import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNextTransition, type OrchestrationDependencies } from "../src/orchestration/transition-runner.js";
import { checkpointAttempt } from "../src/orchestration/controller.js";
import { recoverCompletedAttempt } from "../src/orchestration/recovery.js";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";
import { OrchestrationError } from "../src/orchestration/contracts.js";

const RUN_ID = `TASK-P11-RUN:${"a".repeat(64)}`;
const ARTIFACT = "b".repeat(64);
const OLD_ARTIFACT = "9".repeat(64);
const MANIFEST = "c".repeat(64);
const DIGEST = "d".repeat(64);
const COMMIT = "3".repeat(40);

function registration(artifactSha256 = ARTIFACT, packId = "PACK-P11") {
  return {
    artifact_sha256: artifactSha256,
    manifest_sha256: MANIFEST,
    run_id: RUN_ID,
    pack_id: packId,
    registry_version: "1.0",
    artifact_kind: "web-implementation-pack",
    artifact_size_bytes: 1,
    stored_relative_path: "x",
    task_id: "TASK-P11-RUN",
    task_bundle_sha256: "a".repeat(64),
    repository: {
      id: "repo",
      base_branch: "main",
      base_commit: "1".repeat(40),
      tree_sha: "2".repeat(40),
    },
    bindings: {},
    registered_at: "2026-08-08T00:00:00.000Z",
  } as never;
}

function initialSnapshot(): LifecycleSnapshot {
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

function readySnapshot() {
  const receipt = {
    state: "READY_FOR_PUBLISH",
    run_id: RUN_ID,
    artifact_sha256: ARTIFACT,
    change_set_digest: DIGEST,
  } as never;
  return {
    receipt,
    changeSetDigest: DIGEST,
    changedPaths: ["src/example.ts"],
    source: {
      trusted: {
        runReceipt: {
          run_id: RUN_ID,
          base_commit: "1".repeat(40),
          branch_name: "codex/task-p11",
          remote: "origin",
          remote_url: "https://github.com/example/repo.git",
        },
      },
    },
  } as never;
}

function pushedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    publish_version: "1.1",
    run_id: RUN_ID,
    state: "PUSHED",
    base_commit: "1".repeat(40),
    branch_name: "codex/task-p11",
    remote_name: "origin",
    allowed_remote_url: "https://github.com/example/repo.git",
    change_set_sha256: DIGEST,
    expected_paths: ["src/example.ts"],
    approved_snapshot_sha256: "e".repeat(64),
    commit_sha: COMMIT,
    remote_branch_sha: COMMIT,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:01.000Z",
    committed_at: "2026-08-08T00:00:00.500Z",
    pushed_at: "2026-08-08T00:00:01.000Z",
    ...overrides,
  } as never;
}

test("P11-RUN-001 continue advances REGISTER -> EXECUTE -> PUBLISH with one sealed attempt each", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-runner-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const snapshot = initialSnapshot();
  const reg = registration();
  const deps = {
    async readSnapshot() { return { ...snapshot }; },
    async readPack() { return { archive_sha256: ARTIFACT, manifest: { pack_id: "PACK-P11" } } as never; },
    async registerPack() { return reg; },
    async selectArtifact() { snapshot.registered_artifact_sha256 = ARTIFACT; return reg; },
    async readSelectedArtifact() { return reg; },
    async createExecutorGates() {
      return {
        verifier: { async verify() { return { passed: true, evidence: {} }; } },
        reviewer: { async review() { return { verdict: "APPROVE" as const, evidence: {} }; } },
      };
    },
    async executePack() {
      snapshot.executor_state = "READY_FOR_PUBLISH";
      return { state: "READY_FOR_PUBLISH", change_set_digest: DIGEST, artifact_sha256: ARTIFACT } as never;
    },
    async attestReadyExecutor() { return { changeSetDigest: DIGEST } as never; },
    async publishReadyExecutor() {
      snapshot.publish_state = "PUSHED";
      return { state: "PUSHED", commit_sha: COMMIT, remote_branch_sha: COMMIT } as never;
    },
  } as unknown as OrchestrationDependencies;

  const first = await runNextTransition({
    runId: RUN_ID,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    inputs: { web_pack_path: path.join(root, "pack.zip") },
    dependencies: deps,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  assert.equal(first.planned.transition, "EXECUTE_REGISTERED_PACK");
  const second = await runNextTransition({
    runId: RUN_ID,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    dependencies: deps,
    now: () => new Date("2026-08-08T00:00:01.000Z"),
  });
  assert.equal(second.planned.transition, "PUBLISH");
  const third = await runNextTransition({
    runId: RUN_ID,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    dependencies: deps,
    now: () => new Date("2026-08-08T00:00:02.000Z"),
  });
  assert.equal(third.planned.transition, "OPEN_DRAFT_PR");
  assert.equal(third.ledger.transition_attempts.REGISTER_WEB_PACK, 1);
  assert.equal(third.ledger.transition_attempts.EXECUTE_REGISTERED_PACK, 1);
  assert.equal(third.ledger.transition_attempts.PUBLISH, 1);
});

test("P11-RUN-002 missing Web pack is input-wait, not a failed retry attempt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-input-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const deps = { async readSnapshot() { return initialSnapshot(); } } as unknown as OrchestrationDependencies;
  const result = await runNextTransition({
    runId: RUN_ID,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    dependencies: deps,
  });
  assert.equal(result.needs_input, "web_pack_path");
  assert.equal(result.ledger.budget.total_attempts, 0);
});

test("P11-RUN-003 retryable external failure stops continue without a hot retry loop", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-retry-stop-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const snapshot = initialSnapshot();
  snapshot.registered_artifact_sha256 = ARTIFACT;
  const reg = registration();
  let gateCalls = 0;
  const deps = {
    async readSnapshot() { return { ...snapshot }; },
    async readSelectedArtifact() { return reg; },
    async createExecutorGates() {
      gateCalls += 1;
      const error = new Error("temporary bridge outage") as Error & { code: string };
      error.code = "NETWORK_UNAVAILABLE";
      throw error;
    },
  } as unknown as OrchestrationDependencies;
  const result = await runNextTransition({
    runId: RUN_ID,
    stateDirectory: root,
    configPath: path.join(root, "config.json"),
    dependencies: deps,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  assert.equal(gateCalls, 1);
  assert.equal(result.progressed, false);
  assert.equal(result.ledger.status, "WAITING");
  assert.ok(result.ledger.retry.next_retry_at);
  assert.equal(result.ledger.transition_attempts.EXECUTE_REGISTERED_PACK, 1);
  assert.equal(result.needs_input, null);
});

test("P11-REC-001 restart adopts an exact registered pack instead of replaying registration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-rec-reg-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "REGISTER_WEB_PACK",
    payload: { archive_sha256: ARTIFACT, pack_id: "PACK-P11" },
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  const recovered = await recoverCompletedAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    configPath: path.join(root, "config.json"),
    ledger: started,
    dependencies: {
      async readSelectedArtifactSelection() {
        return { registration: registration(), selected_at: "2026-08-08T00:00:01.000Z" } as never;
      },
    },
    now: () => new Date("2026-08-08T00:00:02.000Z"),
  });
  assert.equal(recovered.current_attempt, null);
  assert.equal(recovered.last_completed_transition, "REGISTER_WEB_PACK");
  assert.equal(recovered.next_transition, "EXECUTE_REGISTERED_PACK");
});

test("P11-REC-002 restart adopts an exact READY executor receipt without a second model/executor turn", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-rec-exec-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "EXECUTE_REGISTERED_PACK",
    payload: { artifact_sha256: ARTIFACT, manifest_sha256: MANIFEST },
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  const ready = readySnapshot();
  const recovered = await recoverCompletedAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    configPath: path.join(root, "config.json"),
    ledger: started,
    dependencies: {
      async readSelectedArtifact() { return registration(); },
      async readExecutorReceiptForRun() { return ready.receipt; },
      async attestReadyExecutorSnapshot() { return ready; },
    },
    now: () => new Date("2026-08-08T00:00:01.000Z"),
  });
  assert.equal(recovered.current_attempt, null);
  assert.equal(recovered.last_completed_transition, "EXECUTE_REGISTERED_PACK");
  assert.equal(recovered.next_transition, "PUBLISH");
});

test("P11-REC-003 restart adopts only an exact PUSHED remote commit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-rec-push-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "PUBLISH",
    payload: { artifact_sha256: ARTIFACT, change_set_digest: DIGEST },
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  const recovered = await recoverCompletedAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    configPath: path.join(root, "config.json"),
    ledger: started,
    dependencies: {
      async readSelectedArtifact() { return registration(); },
      async attestReadyExecutorSnapshot() { return readySnapshot(); },
      async readPublishReceiptForRun() { return pushedReceipt(); },
    },
    now: () => new Date("2026-08-08T00:00:01.000Z"),
  });
  assert.equal(recovered.current_attempt, null);
  assert.equal(recovered.last_completed_transition, "PUBLISH");
  assert.equal(recovered.next_transition, "OPEN_DRAFT_PR");
});

test("P11-REC-004 current selection mismatch fails closed instead of adopting the wrong registration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-rec-conflict-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "REGISTER_WEB_PACK",
    payload: { archive_sha256: ARTIFACT, pack_id: "PACK-P11" },
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  await assert.rejects(
    () => recoverCompletedAttempt({
      stateDirectory: root,
      runId: RUN_ID,
      configPath: path.join(root, "config.json"),
      ledger: started,
      dependencies: {
        async readSelectedArtifactSelection() {
          return {
            registration: registration(ARTIFACT, "PACK-OTHER"),
            selected_at: "2026-08-08T00:00:01.000Z",
          } as never;
        },
      },
    }),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_RECOVERY_CONFLICT",
  );
});

test("P11-REC-005 a selection older than the active registration attempt is ignored as stale history", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-rec-stale-selection-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "REGISTER_WEB_PACK",
    payload: { archive_sha256: ARTIFACT, pack_id: "PACK-P11" },
    now: new Date("2026-08-08T00:00:10.000Z"),
  });
  const recovered = await recoverCompletedAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    configPath: path.join(root, "config.json"),
    ledger: started,
    dependencies: {
      async readSelectedArtifactSelection() {
        return {
          registration: registration(OLD_ARTIFACT, "PACK-OLD"),
          selected_at: "2026-08-08T00:00:09.000Z",
        } as never;
      },
    },
  });
  assert.equal(recovered.current_attempt?.attempt_id, started.current_attempt?.attempt_id);
  assert.equal(recovered.last_completed_transition, null);
});

test("P11-REC-006 PUSHED recovery receipt must bind exact run, digest, target and changed paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-rec-push-conflict-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "PUBLISH",
    payload: { artifact_sha256: ARTIFACT, change_set_digest: DIGEST },
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
  await assert.rejects(
    () => recoverCompletedAttempt({
      stateDirectory: root,
      runId: RUN_ID,
      configPath: path.join(root, "config.json"),
      ledger: started,
      dependencies: {
        async readSelectedArtifact() { return registration(); },
        async attestReadyExecutorSnapshot() { return readySnapshot(); },
        async readPublishReceiptForRun() {
          return pushedReceipt({ branch_name: "codex/wrong-target" });
        },
      },
    }),
    (error: unknown) => error instanceof OrchestrationError && error.code === "ORCHESTRATION_RECOVERY_CONFLICT",
  );
});
