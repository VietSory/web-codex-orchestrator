import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { bindWebReviewRepair } from "../src/executor/repair.js";
import { readExecutorReceipt } from "../src/executor/store.js";
import type { ExecutorVerifierPort } from "../src/executor/gates.js";

function verifierSequence(results: boolean[]): ExecutorVerifierPort {
  let index = 0;
  return {
    async verify(request) {
      const passed = results[Math.min(index, results.length - 1)]!;
      index += 1;
      return { passed, evidence: { kind: "verification", digest: request.change_set_digest, passed } };
    },
  };
}

test("Web repair verification failure persists a non-publishable terminal receipt", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const verifier = verifierSequence([true, false]);
  const initial = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier,
    reviewStrategy: "web",
  });
  const current = Buffer.from("after\n");
  const repaired = Buffer.from("fixed-but-invalid\n");
  await bindWebReviewRepair({
    stateDirectory: fixture.state,
    receipt: initial,
    sourceChangeSetDigest: initial.change_set_digest!,
    sourceReviewEvidenceSha256: crypto.createHash("sha256").update("web-review-revise-failing").digest("hex"),
    operations: [{
      op_id: "web-failing-fix",
      kind: "replace_file",
      path: "app.txt",
      preimage_sha256: crypto.createHash("sha256").update(current).digest("hex"),
      postimage_base64: repaired.toString("base64"),
      postimage_sha256: crypto.createHash("sha256").update(repaired).digest("hex"),
    }],
  });

  const failed = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier,
    reviewStrategy: "web",
  });
  assert.equal(failed.state, "ESCALATE_TO_WEB");
  assert.equal(failed.repair?.reviewer, "web");
  assert.equal(failed.repair?.state, "APPLIED");
  assert.equal(failed.verification.passed, false);
  assert.ok(failed.errors.some((error) => error.code === "EXECUTOR_VERIFICATION_FAILED"));

  const persisted = await readExecutorReceipt(fixture.state, failed.task_id, failed.task_bundle_sha256, failed.artifact_sha256);
  assert.equal(persisted?.state, "ESCALATE_TO_WEB");
  assert.equal(persisted?.repair?.state, "APPLIED");
});
