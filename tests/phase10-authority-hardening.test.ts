import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { ExecutorError, type ExecutorReceipt } from "../src/executor/contracts.js";
import { executorPaths } from "../src/executor/paths.js";
import type { ExecutorReviewerPort, ExecutorVerifierPort } from "../src/executor/gates.js";

const verifier: ExecutorVerifierPort = { async verify(request) { return { passed: true, evidence: { kind: "verification", digest: request.change_set_digest, passed: true } }; } };
const reviewer: ExecutorReviewerPort = { async review(request) { return { verdict: "APPROVE", evidence: { reviewer: request.reviewer, digest: request.change_set_digest, verdict: "APPROVE" } }; } };

async function readyFixture(t: test.TestContext) {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  return { fixture, registration, receipt };
}

function pathsFor(state: string, receipt: ExecutorReceipt) {
  return executorPaths(state, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256);
}

test("P10-MAINT-005 file-mode drift invalidates the exact approved change-set", async (t) => {
  const { fixture, registration } = await readyFixture(t);
  const target = path.join(fixture.repo, "app.txt");
  await fs.chmod(target, 0o755);
  await assert.rejects(() => executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer }), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_POSTIMAGE_MISMATCH");
});

test("P10-MAINT-006 mutable receipt cannot replace the registered transaction operation set", async (t) => {
  const { fixture, registration, receipt } = await readyFixture(t);
  const paths = pathsFor(fixture.state, receipt);
  const parsed = JSON.parse(await fs.readFile(paths.receipt, "utf8")) as ExecutorReceipt;
  parsed.operations[0]!.path = "unregistered.txt";
  await fs.writeFile(paths.receipt, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  await assert.rejects(() => executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer }), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_TRANSACTION_INVALID");
});

test("P10-MAINT-007 READY retry requires the persisted gate evidence it claims", async (t) => {
  const { fixture, registration, receipt } = await readyFixture(t);
  assert.ok(receipt.sol_review.evidence_sha256);
  const paths = pathsFor(fixture.state, receipt);
  const sol = path.join(paths.directory, "evidence", `sol-${receipt.sol_review.rounds}-${receipt.sol_review.evidence_sha256}.json`);
  await fs.unlink(sol);
  await assert.rejects(() => executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer }), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_STATE_INVALID");
});
