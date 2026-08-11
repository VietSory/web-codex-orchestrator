import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { bindWebReviewRepair } from "../src/executor/repair.js";
import { readExecutorReceipt } from "../src/executor/store.js";
import type { ExecutorReviewerPort, ExecutorVerifierPort } from "../src/executor/gates.js";

function passingVerifier(): ExecutorVerifierPort {
  return { async verify(request) { return { passed: true, evidence: { kind: "verification", digest: request.change_set_digest, passed: true } }; } };
}
function passingReviewer(): ExecutorReviewerPort {
  return { async review(request) {
    return {
      verdict: "APPROVE",
      usage: request.reviewer === "terra"
        ? { model_turns: 1, input_tokens: 120, output_tokens: 30 }
        : { model_turns: 1, input_tokens: 80, output_tokens: 20 },
      evidence: { reviewer: request.reviewer, digest: request.change_set_digest, verdict: "APPROVE" },
    };
  } };
}
function selectedReviewer(kind: "sol" | "terra", calls: Array<"sol" | "terra">): ExecutorReviewerPort {
  return {
    reviewer_kind: kind,
    reviewer_profile: {
      model: kind === "sol" ? "gpt-5.6-sol" : "gpt-5.6-terra",
      reasoning_effort: "high",
    },
    async review(request) {
      calls.push(request.reviewer);
      return {
        verdict: "APPROVE",
        usage: { model_turns: 1, input_tokens: kind === "sol" ? 80 : 120, output_tokens: kind === "sol" ? 20 : 30 },
        evidence: { reviewer: request.reviewer, digest: request.change_set_digest, verdict: "APPROVE" },
      };
    },
  };
}

async function setup(t: test.TestContext) {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  return { fixture, registration };
}

test("P10-SVC-001 legacy low-level caller can still exercise Terra + Sol compatibility", async (t) => {
  const { fixture, registration } = await setup(t);
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier: passingVerifier(), reviewer: passingReviewer() });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.equal(receipt.verification.passed, true);
  assert.equal(receipt.terra_review.verdict, "APPROVE");
  assert.equal(receipt.sol_review.verdict, "APPROVE");
  assert.equal(receipt.reviewer_selection, undefined);
  assert.deepEqual(receipt.usage, { model_turns: 2, input_tokens: 200, output_tokens: 50 });
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), "after\n");
});

test("P10-SVC-002 Terra REVISE escalates to Web without a local correction turn", async (t) => {
  const { fixture, registration } = await setup(t);
  let solCalled = false;
  const reviewer: ExecutorReviewerPort = { async review(request) {
    if (request.reviewer === "sol") solCalled = true;
    return request.reviewer === "terra"
      ? { verdict: "REVISE", evidence: { finding: "needs new registered Web pack" } }
      : { verdict: "APPROVE", evidence: {} };
  } };
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier: passingVerifier(), reviewer });
  assert.equal(receipt.state, "ESCALATE_TO_WEB");
  assert.equal(receipt.terra_review.verdict, "REVISE");
  assert.equal(solCalled, false);
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), "after\n");
});

test("P10-SVC-003 mutation during verifier invalidates the gate before review", async (t) => {
  const { fixture, registration } = await setup(t);
  let reviewerCalled = false;
  const verifier: ExecutorVerifierPort = { async verify(request) {
    await fs.writeFile(path.join(request.worktree_path, "unregistered.txt"), "unexpected\n");
    return { passed: true, evidence: { misleading: "pass" } };
  } };
  const reviewer: ExecutorReviewerPort = { async review() { reviewerCalled = true; return { verdict: "APPROVE", evidence: {} }; } };
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer });
  assert.equal(receipt.state, "ESCALATE_TO_WEB");
  assert.equal(reviewerCalled, false);
  assert.ok(receipt.errors.some((error) => error.code === "EXECUTOR_UNREGISTERED_CHANGE"));
});

test("P10-SVC-004 registered-file mutation during Sol review invalidates approval", async (t) => {
  const { fixture, registration } = await setup(t);
  const reviewer: ExecutorReviewerPort = { async review(request) {
    if (request.reviewer === "sol") await fs.writeFile(path.join(request.worktree_path, "app.txt"), "mutated by reviewer\n");
    return { verdict: "APPROVE", evidence: { reviewer: request.reviewer } };
  } };
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier: passingVerifier(), reviewer });
  assert.equal(receipt.state, "ESCALATE_TO_WEB");
  assert.ok(receipt.errors.some((error) => error.code === "EXECUTOR_POSTIMAGE_MISMATCH" || error.code === "EXECUTOR_UNREGISTERED_CHANGE"));
});

test("P10-SVC-005 Sol-selected PAIR executes exactly one Sol review", async (t) => {
  const { fixture, registration } = await setup(t);
  const calls: Array<"sol" | "terra"> = [];
  const receipt = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier: passingVerifier(),
    reviewer: selectedReviewer("sol", calls),
  });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.deepEqual(calls, ["sol"]);
  assert.deepEqual(receipt.reviewer_selection, { kind: "sol", model: "gpt-5.6-sol", reasoning_effort: "high" });
  assert.equal(receipt.terra_review.rounds, 0);
  assert.equal(receipt.terra_review.verdict, null);
  assert.equal(receipt.sol_review.rounds, 1);
  assert.equal(receipt.sol_review.verdict, "APPROVE");
  assert.deepEqual(receipt.usage, { model_turns: 1, input_tokens: 80, output_tokens: 20 });
});

test("P10-SVC-006 Terra-selected PAIR executes exactly one Terra review", async (t) => {
  const { fixture, registration } = await setup(t);
  const calls: Array<"sol" | "terra"> = [];
  const receipt = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier: passingVerifier(),
    reviewer: selectedReviewer("terra", calls),
  });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.deepEqual(calls, ["terra"]);
  assert.deepEqual(receipt.reviewer_selection, { kind: "terra", model: "gpt-5.6-terra", reasoning_effort: "high" });
  assert.equal(receipt.terra_review.rounds, 1);
  assert.equal(receipt.terra_review.verdict, "APPROVE");
  assert.equal(receipt.sol_review.rounds, 0);
  assert.equal(receipt.sol_review.verdict, null);
  assert.deepEqual(receipt.usage, { model_turns: 1, input_tokens: 120, output_tokens: 30 });
});

test("P10-SVC-007 Web review strategy needs no model reviewer", async (t) => {
  const { fixture, registration } = await setup(t);
  const receipt = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier: passingVerifier(),
    reviewStrategy: "web",
  });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.equal(receipt.review_strategy, "web");
  assert.equal(receipt.reviewer_selection, undefined);
  assert.equal(receipt.usage, undefined);
  assert.equal(receipt.terra_review.rounds, 0);
  assert.equal(receipt.sol_review.rounds, 0);
});

test("P10-SVC-008 Web repair is durable, non-publishable while pending, and verifier-only on resume", async (t) => {
  const { fixture, registration } = await setup(t);
  const initial = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier: passingVerifier(),
    reviewStrategy: "web",
  });
  const sourceDigest = initial.change_set_digest!;
  const current = Buffer.from("after\n");
  const repaired = Buffer.from("fixed\n");
  await bindWebReviewRepair({
    stateDirectory: fixture.state,
    receipt: initial,
    sourceChangeSetDigest: sourceDigest,
    sourceReviewEvidenceSha256: crypto.createHash("sha256").update("web-review-revise").digest("hex"),
    operations: [{
      op_id: "web-fix-1",
      kind: "replace_file",
      path: "app.txt",
      preimage_sha256: crypto.createHash("sha256").update(current).digest("hex"),
      postimage_base64: repaired.toString("base64"),
      postimage_sha256: crypto.createHash("sha256").update(repaired).digest("hex"),
    }],
  });
  const pending = await readExecutorReceipt(fixture.state, initial.task_id, initial.task_bundle_sha256, initial.artifact_sha256);
  assert.equal(pending?.state, "REVIEWING_WEB");
  assert.equal(pending?.repair?.state, "PROPOSED");
  assert.equal(pending?.verification.passed, true);

  const resumed = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier: passingVerifier(),
    reviewStrategy: "web",
  });
  assert.equal(resumed.state, "READY_FOR_PUBLISH");
  assert.equal(resumed.repair?.reviewer, "web");
  assert.equal(resumed.repair?.state, "VERIFIED");
  assert.equal(resumed.repair?.final_change_set_digest, resumed.change_set_digest);
  assert.equal(resumed.verification.passed, true);
  assert.equal(resumed.verification.rounds, 2);
  assert.equal(resumed.usage, undefined);
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), "fixed\n");
});
