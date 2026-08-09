import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkpointAttempt } from "../src/orchestration/controller.js";
import { recoverCompletedAttempt } from "../src/orchestration/recovery.js";

const RUN_ID = `TASK-V02-USAGE:${"a".repeat(64)}`;
const ARTIFACT = "b".repeat(64);
const MANIFEST = "c".repeat(64);
const DIGEST = "d".repeat(64);

function registration() {
  return {
    artifact_sha256: ARTIFACT,
    manifest_sha256: MANIFEST,
    run_id: RUN_ID,
  } as never;
}

function readyReceipt() {
  return {
    state: "READY_FOR_PUBLISH",
    run_id: RUN_ID,
    artifact_sha256: ARTIFACT,
    change_set_digest: DIGEST,
    usage: {
      model_turns: 2,
      input_tokens: 200,
      output_tokens: 50,
    },
  } as never;
}

test("v0.2 recovery adopts initial executor usage exactly once", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-v02-usage-recovery-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const started = await checkpointAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    transition: "EXECUTE_REGISTERED_PACK",
    payload: { artifact_sha256: ARTIFACT, manifest_sha256: MANIFEST },
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  const receipt = readyReceipt();
  const dependencies = {
    async readSelectedArtifact() { return registration(); },
    async readExecutorReceiptForRun() { return receipt; },
    async attestReadyExecutorSnapshot() {
      return {
        receipt,
        changeSetDigest: DIGEST,
        changedPaths: ["src/example.ts"],
        source: { trusted: { runReceipt: { run_id: RUN_ID } } },
      } as never;
    },
  };

  const recovered = await recoverCompletedAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    configPath: path.join(root, "config.json"),
    ledger: started,
    dependencies,
    now: () => new Date("2026-08-09T00:00:01.000Z"),
  });

  assert.equal(recovered.current_attempt, null);
  assert.equal(recovered.last_completed_transition, "EXECUTE_REGISTERED_PACK");
  assert.equal(recovered.next_transition, "PUBLISH");
  assert.equal(recovered.budget.model_turns, 2);
  assert.equal(recovered.budget.input_tokens, 200);
  assert.equal(recovered.budget.output_tokens, 50);

  const recoveredAgain = await recoverCompletedAttempt({
    stateDirectory: root,
    runId: RUN_ID,
    configPath: path.join(root, "config.json"),
    ledger: recovered,
    dependencies,
    now: () => new Date("2026-08-09T00:00:02.000Z"),
  });

  assert.equal(recoveredAgain.budget.model_turns, 2);
  assert.equal(recoveredAgain.budget.input_tokens, 200);
  assert.equal(recoveredAgain.budget.output_tokens, 50);
});
