import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { readExecutorReceipt } from "../src/executor/store.js";
import type { ExecutorReviewerPort, ExecutorVerifierPort } from "../src/executor/gates.js";

function passingVerifier(): ExecutorVerifierPort {
  return { async verify(request) { return { passed: true, evidence: { kind: "verification", digest: request.change_set_digest, passed: true } }; } };
}

async function setup(t: test.TestContext) {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  return { fixture, registration };
}

type BrowserReviewMode = "approve" | "reject" | "crash";
type ReviewCall = { digest: string; prior: string[] };

function browserRepairReviewer(mode: BrowserReviewMode, calls: ReviewCall[]): ExecutorReviewerPort {
  const current = Buffer.from("after\n");
  const repaired = Buffer.from("fixed\n");
  return {
    reviewer_kind: "terra",
    reviewer_profile: { model: "chatgpt-web", reasoning_effort: "high" },
    repair_reapproval_required: true,
    budget_policy: {
      maximum_model_turns: 2,
      maximum_elapsed_ms: 60_000,
      maximum_input_tokens: 1_000_000,
      maximum_output_tokens: 1_000_000,
    },
    async review(request) {
      calls.push({ digest: request.change_set_digest, prior: [...request.prior_evidence_sha256] });
      if (calls.length === 1) {
        return {
          verdict: "REVISE",
          usage: { model_turns: 0, input_tokens: 0, output_tokens: 0 },
          evidence: { pass: "initial", digest: request.change_set_digest, verdict: "REVISE" },
          repair_operations: [{
            op_id: "browser-fix-1",
            kind: "replace_file",
            path: "app.txt",
            preimage_sha256: crypto.createHash("sha256").update(current).digest("hex"),
            postimage_base64: repaired.toString("base64"),
            postimage_sha256: crypto.createHash("sha256").update(repaired).digest("hex"),
          }],
        };
      }
      if (mode === "crash") throw new Error("simulated browser helper interruption after final review started");
      if (mode === "reject") {
        return {
          verdict: "ESCALATE",
          usage: { model_turns: 0, input_tokens: 0, output_tokens: 0 },
          evidence: { pass: "final", digest: request.change_set_digest, verdict: "ESCALATE" },
        };
      }
      return {
        verdict: "APPROVE",
        usage: { model_turns: 0, input_tokens: 0, output_tokens: 0 },
        evidence: { pass: "final", digest: request.change_set_digest, verdict: "APPROVE" },
      };
    },
  };
}

test("browser PAIR re-reviews and APPROVEs the exact repaired digest before READY_FOR_PUBLISH", async (t) => {
  const { fixture, registration } = await setup(t);
  const calls: ReviewCall[] = [];
  const receipt = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier: passingVerifier(),
    reviewer: browserRepairReviewer("approve", calls),
    reviewStrategy: "model",
  });

  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.digest, calls[1]!.digest);
  assert.equal(calls[0]!.prior.length, 1);
  assert.equal(calls[1]!.prior.length, 2);
  assert.deepEqual(receipt.reviewer_selection, { kind: "terra", model: "chatgpt-web", reasoning_effort: "high" });
  assert.equal(receipt.terra_review.verdict, "REVISE");
  assert.equal(receipt.terra_review.change_set_digest, receipt.repair?.source_change_set_digest);
  assert.equal(receipt.repair?.state, "VERIFIED");
  assert.equal(receipt.repair?.final_change_set_digest, calls[1]!.digest);
  assert.equal(receipt.change_set_digest, calls[1]!.digest);
  assert.equal(receipt.verification.change_set_digest, calls[1]!.digest);
  assert.equal(receipt.repair_reapproval?.rounds, 1);
  assert.equal(receipt.repair_reapproval?.verdict, "APPROVE");
  assert.equal(receipt.repair_reapproval?.change_set_digest, calls[1]!.digest);
  assert.match(receipt.repair_reapproval?.evidence_sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.usage, { model_turns: 2, input_tokens: 0, output_tokens: 0 });
  assert.equal(await fs.readFile(path.join(fixture.repo, "app.txt"), "utf8"), "fixed\n");
});

test("browser PAIR cannot publish when the fresh repaired-digest review does not APPROVE", async (t) => {
  const { fixture, registration } = await setup(t);
  const calls: ReviewCall[] = [];
  const receipt = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier: passingVerifier(),
    reviewer: browserRepairReviewer("reject", calls),
    reviewStrategy: "model",
  });

  assert.equal(calls.length, 2);
  assert.equal(receipt.state, "ESCALATE_TO_WEB");
  assert.equal(receipt.repair?.state, "VERIFIED");
  assert.equal(receipt.repair_reapproval?.verdict, "ESCALATE");
  assert.equal(receipt.repair_reapproval?.change_set_digest, receipt.change_set_digest);
  assert.ok(receipt.errors.some((error) => error.code === "EXECUTOR_REVIEW_REJECTED"));
});

test("browser PAIR never replays an ambiguous repaired-digest review after interruption", async (t) => {
  const { fixture, registration } = await setup(t);
  const calls: ReviewCall[] = [];
  const reviewer = browserRepairReviewer("crash", calls);

  await assert.rejects(
    () => executeRegisteredWebPack({
      runId: fixture.runId,
      artifactSha256: registration.artifact_sha256,
      stateDirectory: fixture.state,
      configPath: fixture.config,
      verifier: passingVerifier(),
      reviewer,
      reviewStrategy: "model",
    }),
    /simulated browser helper interruption/,
  );

  const pending = await readExecutorReceipt(fixture.state, fixture.taskId, fixture.archiveSha, registration.artifact_sha256);
  assert.equal(pending?.state, "REVIEWING_TERRA");
  assert.equal(pending?.repair?.state, "VERIFIED");
  assert.equal(pending?.repair_reapproval?.rounds, 0);
  assert.equal(pending?.repair_reapproval?.verdict, null);
  assert.equal(pending?.usage?.model_turns, 2);
  assert.equal(calls.length, 2);

  const resumed = await executeRegisteredWebPack({
    runId: fixture.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: fixture.state,
    configPath: fixture.config,
    verifier: passingVerifier(),
    reviewer,
    reviewStrategy: "model",
  });
  assert.equal(resumed.state, "FAILED");
  assert.ok(resumed.errors.some((error) => error.code === "EXECUTOR_AMBIGUOUS_RECOVERY"));
  assert.equal(calls.length, 2);
});

test("model strategy rejects arbitrary Terra model identities while allowing only the explicit browser exception", async (t) => {
  const { fixture, registration } = await setup(t);
  const reviewer: ExecutorReviewerPort = {
    reviewer_kind: "terra",
    reviewer_profile: { model: "gpt-5.6-fake", reasoning_effort: "high" },
    async review() { return { verdict: "APPROVE", evidence: {} }; },
  };
  await assert.rejects(
    () => executeRegisteredWebPack({
      runId: fixture.runId,
      artifactSha256: registration.artifact_sha256,
      stateDirectory: fixture.state,
      configPath: fixture.config,
      verifier: passingVerifier(),
      reviewer,
      reviewStrategy: "model",
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EXECUTOR_STATE_INVALID"),
  );
});
