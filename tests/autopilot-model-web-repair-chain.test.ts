import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { bindWebReviewRepair } from "../src/executor/repair.js";
import type { ExecutorReviewerPort, ExecutorVerifierPort } from "../src/executor/gates.js";

const sha = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const verifier: ExecutorVerifierPort = {
  async verify(request) {
    return { passed: true, evidence: { kind: "verification", digest: request.change_set_digest, passed: true } };
  },
};

test("AUTOPILOT-AUTH-001 one Sol REVISE+repair pass remains authoritative through later Web-A repair without a second model call", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({
    runId: fixture.runId,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    archivePath: archive,
  });

  const original = Buffer.from("after\n");
  const modelFixed = Buffer.from("model-fixed\n");
  const webFinal = Buffer.from("web-final\n");
  let reviewerCalls = 0;
  const reviewer: ExecutorReviewerPort = {
    reviewer_kind: "sol",
    reviewer_profile: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    async review(request) {
      reviewerCalls += 1;
      return {
        verdict: "REVISE",
        usage: { model_turns: 1, input_tokens: 100, output_tokens: 30 },
        evidence: { reviewer: "sol", digest: request.change_set_digest, verdict: "REVISE" },
        repair_operations: [{
          op_id: "sol-fix-1",
          kind: "replace_file",
          path: "app.txt",
          preimage_sha256: sha(original),
          postimage_base64: modelFixed.toString("base64"),
          postimage_sha256: sha(modelFixed),
        }],
      };
    },
  };

  let receipt = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier,
    reviewer,
    reviewStrategy: "model",
  });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.equal(receipt.reviewer_selection?.kind, "sol");
  assert.equal(receipt.sol_review.verdict, "REVISE");
  assert.equal(receipt.repair?.reviewer, "sol");
  assert.equal(receipt.repair?.state, "VERIFIED");
  assert.equal(reviewerCalls, 1);
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), modelFixed.toString("utf8"));

  const modelDigest = receipt.change_set_digest!;
  await bindWebReviewRepair({
    stateDirectory: fixture.state,
    receipt,
    sourceChangeSetDigest: modelDigest,
    sourceReviewEvidenceSha256: sha("web-a-final-revise"),
    operations: [{
      op_id: "web-a-fix-1",
      kind: "replace_file",
      path: "app.txt",
      preimage_sha256: sha(modelFixed),
      postimage_base64: webFinal.toString("base64"),
      postimage_sha256: sha(webFinal),
    }],
  });

  assert.equal(receipt.repair_history?.length, 1);
  assert.equal(receipt.repair_history?.[0]?.reviewer, "sol");
  assert.equal(receipt.repair_history?.[0]?.final_change_set_digest, modelDigest);
  assert.equal(receipt.repair?.reviewer, "web");
  assert.equal(receipt.state, "REVIEWING_WEB");

  receipt = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier,
    reviewStrategy: "model",
  });

  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.equal(receipt.repair?.reviewer, "web");
  assert.equal(receipt.repair?.state, "VERIFIED");
  assert.equal(receipt.verification.passed, true);
  assert.equal(receipt.verification.change_set_digest, receipt.change_set_digest);
  assert.notEqual(receipt.change_set_digest, modelDigest);
  assert.equal(reviewerCalls, 1, "final Web-A repair recovery must never instantiate or call the selected reviewer again");
  assert.deepEqual(receipt.usage, { model_turns: 1, input_tokens: 100, output_tokens: 30 });
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), webFinal.toString("utf8"));
});
