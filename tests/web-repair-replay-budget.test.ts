import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { bindWebReviewRepair } from "../src/executor/repair.js";
import { ExecutorError } from "../src/executor/contracts.js";
import type { ExecutorVerifierPort } from "../src/executor/gates.js";

const sha = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const verifier: ExecutorVerifierPort = {
  async verify(request) {
    return { passed: true, evidence: { kind: "verification", digest: request.change_set_digest, passed: true } };
  },
};

function isRepairInvalid(error: unknown): boolean {
  return error instanceof ExecutorError && error.code === "EXECUTOR_REPAIR_INVALID";
}

test("PAIR Web repair requires exact replay identity and enforces a total four-generation budget", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({
    runId: fixture.runId,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    archivePath: archive,
  });

  let receipt = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier,
    reviewStrategy: "web",
  });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");

  let current = Buffer.from("after\n");
  for (let generation = 1; generation <= 4; generation += 1) {
    const next = Buffer.from(`web-fix-${generation}\n`);
    const evidence = sha(`web-review-evidence-${generation}`);
    const operation = {
      op_id: `web-fix-${generation}`,
      kind: "replace_file" as const,
      path: "app.txt",
      preimage_sha256: sha(current),
      postimage_base64: next.toString("base64"),
      postimage_sha256: sha(next),
    };

    const firstBinding = await bindWebReviewRepair({
      stateDirectory: fixture.state,
      receipt,
      sourceChangeSetDigest: receipt.change_set_digest!,
      sourceReviewEvidenceSha256: evidence,
      operations: [operation],
    });
    const exactReplay = await bindWebReviewRepair({
      stateDirectory: fixture.state,
      receipt,
      sourceChangeSetDigest: receipt.change_set_digest!,
      sourceReviewEvidenceSha256: evidence,
      operations: [operation],
    });
    assert.equal(exactReplay, firstBinding, "exact replay must be idempotent and preserve the same durable receipt object");

    if (generation === 1) {
      const conflicting = Buffer.from("conflicting-postimage\n");
      await assert.rejects(
        () => bindWebReviewRepair({
          stateDirectory: fixture.state,
          receipt,
          sourceChangeSetDigest: receipt.change_set_digest!,
          sourceReviewEvidenceSha256: evidence,
          operations: [{ ...operation, postimage_base64: conflicting.toString("base64"), postimage_sha256: sha(conflicting) }],
        }),
        isRepairInvalid,
        "the same evidence digest must never authorize different operations",
      );
    }

    receipt = await executeRegisteredWebPack({
      runId: fixture.runId,
      artifactSha256: registration.artifact_sha256,
      stateDirectory: fixture.state,
      configPath: fixture.config,
      verifier,
      reviewStrategy: "web",
    });
    assert.equal(receipt.state, "READY_FOR_PUBLISH");
    assert.equal(receipt.repair?.state, "VERIFIED");
    current = next;
  }

  assert.equal(receipt.repair_history?.length, 3, "three completed generations are archived while the fourth remains current");
  assert.equal(receipt.repair?.state, "VERIFIED");

  const fifth = Buffer.from("web-fix-5\n");
  await assert.rejects(
    () => bindWebReviewRepair({
      stateDirectory: fixture.state,
      receipt,
      sourceChangeSetDigest: receipt.change_set_digest!,
      sourceReviewEvidenceSha256: sha("web-review-evidence-5"),
      operations: [{
        op_id: "web-fix-5",
        kind: "replace_file",
        path: "app.txt",
        preimage_sha256: sha(current),
        postimage_base64: fifth.toString("base64"),
        postimage_sha256: sha(fifth),
      }],
    }),
    isRepairInvalid,
    "a fifth repair must be rejected before any new mutation authority is persisted",
  );
});
