import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import type { ExecutorReviewerPort, ExecutorVerifierPort } from "../src/executor/gates.js";

function verifier(): ExecutorVerifierPort {
  return { async verify() { return { passed: true, evidence: { kind: "verification" } }; } };
}
function policy(overrides: Partial<NonNullable<ExecutorReviewerPort["budget_policy"]>> = {}): NonNullable<ExecutorReviewerPort["budget_policy"]> {
  return { maximum_model_turns: 2, maximum_elapsed_ms: 60_000, maximum_input_tokens: 1_000, maximum_output_tokens: 1_000, ...overrides };
}
async function setup(t: test.TestContext) {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  return { fixture, registration };
}

test("v0.2 executor reserves each review turn before calling the provider and blocks the next call at the hard turn limit", async (t) => {
  const { fixture, registration } = await setup(t);
  let calls = 0;
  const reviewer: ExecutorReviewerPort = {
    budget_policy: policy({ maximum_model_turns: 1 }),
    async review(request) {
      calls += 1;
      return { verdict: "APPROVE", evidence: { reviewer: request.reviewer }, usage: { model_turns: 0, input_tokens: 10, output_tokens: 2 } };
    },
  };
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier: verifier(), reviewer, now: () => new Date("2026-08-09T00:00:01.000Z") });
  assert.equal(calls, 1, "Sol provider call must not start after the durable Terra reservation consumes the budget");
  assert.equal(receipt.state, "FAILED");
  assert.equal(receipt.usage?.model_turns, 1);
  assert.equal(receipt.usage?.input_tokens, 10);
  assert.equal(receipt.usage?.output_tokens, 2);
  assert.ok(receipt.errors.some((error) => error.code === "EXECUTOR_BUDGET_EXHAUSTED"));
});

test("v0.2 executor keeps reserved turns and measured tokens separate without double-counting", async (t) => {
  const { fixture, registration } = await setup(t);
  const reviewer: ExecutorReviewerPort = {
    budget_policy: policy(),
    async review(request) {
      return { verdict: "APPROVE", evidence: { reviewer: request.reviewer }, usage: request.reviewer === "terra" ? { model_turns: 0, input_tokens: 11, output_tokens: 3 } : { model_turns: 0, input_tokens: 13, output_tokens: 5 } };
    },
  };
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier: verifier(), reviewer, now: () => new Date("2026-08-09T00:00:01.000Z") });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.deepEqual(receipt.usage, { model_turns: 2, input_tokens: 24, output_tokens: 8 });
});

test("v0.2 measured token overrun is terminal after the current response and prevents every later review call", async (t) => {
  const { fixture, registration } = await setup(t);
  let calls = 0;
  const reviewer: ExecutorReviewerPort = {
    budget_policy: policy({ maximum_input_tokens: 20 }),
    async review(request) {
      calls += 1;
      return { verdict: "APPROVE", evidence: { reviewer: request.reviewer }, usage: { model_turns: 0, input_tokens: 21, output_tokens: 1 } };
    },
  };
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier: verifier(), reviewer, now: () => new Date("2026-08-09T00:00:01.000Z") });
  assert.equal(calls, 1);
  assert.equal(receipt.state, "FAILED");
  assert.deepEqual(receipt.usage, { model_turns: 1, input_tokens: 21, output_tokens: 1 });
  assert.ok(receipt.errors.some((error) => error.code === "EXECUTOR_BUDGET_EXHAUSTED"));
});
