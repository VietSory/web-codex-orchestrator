import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { bindWebReviewRepair } from "../src/executor/repair.js";
import type { ExecutorVerifierPort } from "../src/executor/gates.js";

const sha = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const verifier: ExecutorVerifierPort = { async verify(request) { return { passed: true, evidence: { kind: "verification", digest: request.change_set_digest, passed: true } }; } };

test("PAIR Harness preserves immutable evidence across sequential Web repair generations", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  let receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewStrategy: "web" });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");

  const initial = Buffer.from("after\n");
  const first = Buffer.from("web-fix-one\n");
  const firstEvidence = sha("web-review-generation-one");
  await bindWebReviewRepair({ stateDirectory: fixture.state, receipt, sourceChangeSetDigest: receipt.change_set_digest!, sourceReviewEvidenceSha256: firstEvidence, operations: [{ op_id: "web-fix-1", kind: "replace_file", path: "app.txt", preimage_sha256: sha(initial), postimage_base64: first.toString("base64"), postimage_sha256: sha(first) }] });
  receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewStrategy: "web" });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.equal(receipt.repair?.state, "VERIFIED");
  const firstFinalDigest = receipt.change_set_digest!;

  const second = Buffer.from("web-fix-two\n");
  const secondEvidence = sha("web-review-generation-two");
  await bindWebReviewRepair({ stateDirectory: fixture.state, receipt, sourceChangeSetDigest: firstFinalDigest, sourceReviewEvidenceSha256: secondEvidence, operations: [{ op_id: "web-fix-2", kind: "replace_file", path: "app.txt", preimage_sha256: sha(first), postimage_base64: second.toString("base64"), postimage_sha256: sha(second) }] });
  assert.equal(receipt.repair_history?.length, 1);
  assert.equal(receipt.repair_history?.[0]?.generation, 1);
  assert.equal(receipt.repair_history?.[0]?.source_review_evidence_sha256, firstEvidence);
  assert.equal(receipt.repair_history?.[0]?.final_change_set_digest, firstFinalDigest);
  assert.equal(receipt.repair?.source_change_set_digest, firstFinalDigest);
  assert.equal(receipt.repair?.source_review_evidence_sha256, secondEvidence);

  receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewStrategy: "web" });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.equal(receipt.repair?.state, "VERIFIED");
  assert.equal(receipt.verification.passed, true);
  assert.equal(receipt.verification.change_set_digest, receipt.change_set_digest);
  assert.notEqual(receipt.change_set_digest, firstFinalDigest);
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), second.toString("utf8"));
});