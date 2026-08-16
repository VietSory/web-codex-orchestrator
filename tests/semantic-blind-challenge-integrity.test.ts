import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildSemanticChallengeEvidence, createSemanticChallengeRequest, parseSemanticChallengeAction, semanticChallengePrompt } from "../src/semantic/blind-challenge.js";

const repository = { repository_id: "repo-integrity", base_branch: "main", base_commit: "a".repeat(40) };
const bytes = Buffer.from("authoritative challenge evidence");
const contentSha = crypto.createHash("sha256").update(bytes).digest("hex");

function request() {
  return createSemanticChallengeRequest({ challengeId: "challenge-integrity", repository, originalGoal: "Preserve recovery authority while changing continuation behavior." });
}

function observations() {
  return [{
    sequence: 1,
    request_id: "read-integrity",
    command: { operation: "read", regions: [{ path: "src/recovery.ts", start_byte: 0, end_byte_exclusive: bytes.length }] },
    result: {
      files: [{
        path: "src/recovery.ts",
        content_base64: bytes.toString("base64"),
        content_sha256: contentSha,
        blob_sha: "b".repeat(40),
        size_bytes: bytes.length,
        start_byte: 0,
        end_byte_exclusive: bytes.length,
        total_bytes: bytes.length,
      }],
      metrics: {
        context_bytes_prepared: bytes.length,
        context_bytes_transmitted: bytes.length,
        repeated_bytes_avoided: 0,
        files_considered: 1,
        files_read: 1,
        regions_read: 1,
        cache_hits: 0,
        cache_misses: 1,
      },
    },
  }];
}

function sealed(active: ReturnType<typeof request>) {
  const goalSha = semanticChallengePrompt(active).match(/Original goal SHA-256: ([a-f0-9]{64})/)?.[1];
  assert.ok(goalSha);
  return {
    kind: "semantic_understanding_sealed",
    envelope: {
      schema_version: "1.0",
      kind: "semantic_understanding_sealed",
      challenge_id: active.challenge_id,
      repository,
      original_goal_sha256: goalSha,
      findings: [{
        finding_id: "RECOVERY_BOUNDARY",
        category: "invariant",
        statement: "Recovery authority must remain bound to durable state.",
        citations: [{ path: "src/recovery.ts", content_sha256: contentSha, start_byte: 0, end_byte_exclusive: bytes.length }],
      }],
      unresolved_questions: [],
    },
  };
}

test("post-build observation mutation invalidates challenge evidence before citation validation", () => {
  const active = request();
  const evidence = buildSemanticChallengeEvidence({ request: active, observations: observations() });
  const action = sealed(active);
  assert.equal(parseSemanticChallengeAction(action, active, evidence).kind, "semantic_understanding_sealed");

  const read = evidence.evidence_index.observations[0]!.result;
  assert.equal(read.kind, "read");
  if (read.kind === "read") read.files[0]!.path = "src/fabricated.ts";
  assert.throws(() => parseSemanticChallengeAction(action, active, evidence), /evidence index changed after validation/);
});

test("challenge evidence receipt digest itself is re-attested at seal time", () => {
  const active = request();
  const evidence = buildSemanticChallengeEvidence({ request: active, observations: observations() });
  evidence.challenge_evidence_sha256 = "f".repeat(64);
  assert.throws(() => parseSemanticChallengeAction(sealed(active), active, evidence), /evidence receipt digest is invalid/);
});
