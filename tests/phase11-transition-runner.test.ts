import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNextTransition, type OrchestrationDependencies } from "../src/orchestration/transition-runner.js";
import type { LifecycleSnapshot } from "../src/orchestration/planner.js";

const RUN_ID = `TASK-P11-RUN:${"a".repeat(64)}`;
const ARTIFACT = "b".repeat(64);
const MANIFEST = "c".repeat(64);

function registration() {
  return { artifact_sha256: ARTIFACT, manifest_sha256: MANIFEST, run_id: RUN_ID, pack_id: "PACK-P11", registry_version: "1.0", artifact_kind: "web-implementation-pack", artifact_size_bytes: 1, stored_relative_path: "x", task_id: "TASK-P11-RUN", task_bundle_sha256: "a".repeat(64), repository: { id: "repo", base_branch: "main", base_commit: "1".repeat(40), tree_sha: "2".repeat(40) }, bindings: {}, registered_at: "2026-08-08T00:00:00.000Z" } as never;
}

function initialSnapshot(): LifecycleSnapshot {
  return { registered_artifact_sha256: null, executor_state: null, publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_review_state: null, revision_state: null, revision_result_ready: false };
}

test("P11-RUN-001 continue advances REGISTER -> EXECUTE -> PUBLISH with one sealed attempt each", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-runner-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const snapshot = initialSnapshot();
  const reg = registration();
  const deps = {
    async readSnapshot() { return { ...snapshot }; },
    async readPack() { return { archive_sha256: ARTIFACT, manifest: { pack_id: "PACK-P11" } } as never; },
    async registerPack() { return reg; },
    async selectArtifact() { snapshot.registered_artifact_sha256 = ARTIFACT; return reg; },
    async readSelectedArtifact() { return reg; },
    async createExecutorGates() { return { verifier: { async verify() { return { passed: true, evidence: {} }; } }, reviewer: { async review() { return { verdict: "APPROVE" as const, evidence: {} }; } } }; },
    async executePack() { snapshot.executor_state = "READY_FOR_PUBLISH"; return { state: "READY_FOR_PUBLISH", change_set_digest: "d".repeat(64), artifact_sha256: ARTIFACT } as never; },
    async attestReadyExecutor() { return { changeSetDigest: "d".repeat(64) } as never; },
    async publishReadyExecutor() { snapshot.publish_state = "PUSHED"; return { state: "PUSHED", commit_sha: "3".repeat(40), remote_branch_sha: "3".repeat(40) } as never; },
  } as unknown as OrchestrationDependencies;

  const first = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), inputs: { web_pack_path: path.join(root, "pack.zip") }, dependencies: deps, now: () => new Date("2026-08-08T00:00:00.000Z") });
  assert.equal(first.planned.transition, "EXECUTE_REGISTERED_PACK");
  const second = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps, now: () => new Date("2026-08-08T00:00:01.000Z") });
  assert.equal(second.planned.transition, "PUBLISH");
  const third = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps, now: () => new Date("2026-08-08T00:00:02.000Z") });
  assert.equal(third.planned.transition, "OPEN_DRAFT_PR");
  assert.equal(third.ledger.transition_attempts.REGISTER_WEB_PACK, 1);
  assert.equal(third.ledger.transition_attempts.EXECUTE_REGISTERED_PACK, 1);
  assert.equal(third.ledger.transition_attempts.PUBLISH, 1);
});

test("P11-RUN-002 missing Web pack is input-wait, not a failed retry attempt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-p11-input-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const deps = { async readSnapshot() { return initialSnapshot(); } } as unknown as OrchestrationDependencies;
  const result = await runNextTransition({ runId: RUN_ID, stateDirectory: root, configPath: path.join(root, "config.json"), dependencies: deps });
  assert.equal(result.needs_input, "web_pack_path");
  assert.equal(result.ledger.budget.total_attempts, 0);
});
