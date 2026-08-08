import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { ExecutorError } from "../src/executor/contracts.js";
import type { ExecutorReviewerPort, ExecutorVerifierPort } from "../src/executor/gates.js";

const verifier: ExecutorVerifierPort = { async verify(request) { return { passed: true, evidence: { digest: request.change_set_digest, passed: true } }; } };
const reviewer: ExecutorReviewerPort = { async review(request) { return { verdict: "APPROVE", evidence: { reviewer: request.reviewer, digest: request.change_set_digest } }; } };

test("P10-SVC-005 READY retry re-attests exact worktree digest instead of trusting stale success", async (t) => {
  const fixture = await createPhase9Fixture(); t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const first = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer });
  assert.equal(first.state, "READY_FOR_PUBLISH");
  await fs.writeFile(path.join(fixture.repo, "app.txt"), "drift after ready\n");
  await assert.rejects(() => executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer }), (error: unknown) => error instanceof ExecutorError && (error.code === "EXECUTOR_POSTIMAGE_MISMATCH" || error.code === "EXECUTOR_UNREGISTERED_CHANGE"));
});
