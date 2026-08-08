import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { ExecutorError } from "../src/executor/contracts.js";
import { executorPaths } from "../src/executor/paths.js";
import type { ExecutorReviewerPort, ExecutorVerifierPort } from "../src/executor/gates.js";

const verifier: ExecutorVerifierPort = { async verify(request) { return { passed: true, evidence: { kind: "verification", digest: request.change_set_digest, passed: true } }; } };
const reviewer: ExecutorReviewerPort = { async review(request) { return { verdict: "APPROVE", evidence: { reviewer: request.reviewer, digest: request.change_set_digest, verdict: "APPROVE" } }; } };

test("P10-MAINT-008 missing registered preimage backup invalidates crash/terminal resume", async (t) => {
  const fixture = await createPhase9Fixture(); t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  const backedUp = receipt.operations.find((operation) => operation.kind !== "create_file");
  assert.ok(backedUp?.backup_relative_path);
  const paths = executorPaths(fixture.state, receipt.task_id, receipt.task_bundle_sha256, receipt.artifact_sha256);
  await fs.unlink(path.join(paths.directory, ...backedUp.backup_relative_path.split("/")));
  await assert.rejects(() => executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer }), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_TRANSACTION_INVALID");
});
