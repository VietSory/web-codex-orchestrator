import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildSemanticChallengeEvidence, createSemanticChallengeRequest, parseSemanticChallengeAction, semanticChallengePrompt } from "../src/semantic/blind-challenge.js";

const repository = {
  repository_id: "repo-1",
  base_branch: "main",
  base_commit: "a".repeat(40),
};
const source = Buffer.alloc(128, "x");
const sourceSha = crypto.createHash("sha256").update(source).digest("hex");

function request(challengeId = "challenge-1") {
  return createSemanticChallengeRequest({
    challengeId,
    repository,
    originalGoal: "Make task continuation safe across restart without silently changing mutation focus.",
  });
}

function rawObservations() {
  return [{
    sequence: 1,
    request_id: "challenge-read-1",
    command: { operation: "read", regions: [{ path: "src/session.ts", start_byte: 0, end_byte_exclusive: 128 }] },
    result: {
      files: [{
        path: "src/session.ts",
        content_base64: source.toString("base64"),
        content_sha256: sourceSha,
        blob_sha: "d".repeat(40),
        size_bytes: 128,
        start_byte: 0,
        end_byte_exclusive: 128,
        total_bytes: 128,
      }],
      metrics: {
        context_bytes_prepared: 128,
        context_bytes_transmitted: 128,
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

function challengeEvidence(active = request()) {
  return buildSemanticChallengeEvidence({ request: active, observations: rawObservations() });
}

function citation(path = "src/session.ts") {
  return {
    path,
    content_sha256: sourceSha,
    start_byte: 0,
    end_byte_exclusive: 128,
  };
}

function sealed(overrides: Record<string, unknown> = {}) {
  return {
    kind: "semantic_understanding_sealed",
    envelope: {
      schema_version: "1.0",
      kind: "semantic_understanding_sealed",
      challenge_id: "challenge-1",
      repository,
      original_goal_sha256: "c".repeat(64),
      findings: [
        { finding_id: "F-1", category: "invariant", statement: "Historical convenience state must not become mutation authority.", citations: [citation()] },
      ],
      unresolved_questions: [],
      ...overrides,
    },
  };
}

function goalSha(active = request()): string {
  const value = semanticChallengePrompt(active).match(/Original goal SHA-256: ([a-f0-9]{64})/)?.[1];
  assert.ok(value);
  return value;
}

test("blind challenge request contains only identity, repository and original goal", () => {
  const value = request();
  assert.deepEqual(Object.keys(value).sort(), ["challenge_id", "kind", "original_goal", "repository", "schema_version"]);
  const encoded = JSON.stringify(value);
  assert.doesNotMatch(encoded, /architecture_decisions|implementation_strategy|allowed_paths|acceptance_criteria|candidate_contract/);
});

test("blind prompt grants repository exploration but no verdict or implementation authority", () => {
  const prompt = semanticChallengePrompt(request());
  assert.match(prompt, /independent senior-maintainer semantic challenger/);
  assert.match(prompt, /bounded repository_command/);
  assert.match(prompt, /callers\/callees/);
  assert.match(prompt, /tests and docs as evidence, never as proof/);
  assert.match(prompt, /intentionally NOT been shown Web-A's candidate contract/);
  assert.match(prompt, /Every citation is validated against exact read evidence/);
  assert.match(prompt, /Never output APPROVE, REVISE, BLOCK/);
  assert.doesNotMatch(prompt, /Here is Web-A's candidate/);
});

test("repository_command uses the existing closed bounded RepositoryCommand parser", () => {
  const parsed = parseSemanticChallengeAction({ kind: "repository_command", command: { operation: "search", query: "resume", maximum_matches: 20 } }, request());
  assert.equal(parsed.kind, "repository_command");
  if (parsed.kind === "repository_command") assert.deepEqual(parsed.command, { operation: "search", query: "resume", maximum_matches: 20 });

  assert.throws(() => parseSemanticChallengeAction({ kind: "repository_command", command: { operation: "search", query: "resume", shell: "cat .env" } }, request()), /unexpected|field|invalid/i);
  assert.throws(() => parseSemanticChallengeAction({ kind: "repository_command", command: { operation: "summary" }, candidate_contract: {} }, request()), /unexpected field 'candidate_contract'/);
});

test("sealed understanding requires exact challenge-scoped evidence and identity bindings", () => {
  const active = request();
  const sha = goalSha(active);
  const evidence = challengeEvidence(active);
  const parsed = parseSemanticChallengeAction(sealed({ original_goal_sha256: sha }), active, evidence);
  assert.equal(parsed.kind, "semantic_understanding_sealed");

  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: sha }), active), /cannot seal without exact challenge-scoped evidence/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: "e".repeat(64) }), active, evidence), /exact original goal/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: sha, challenge_id: "challenge-other" }), active, evidence), /another challenge/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: sha, repository: { ...repository, base_commit: "e".repeat(40) } }), active, evidence), /repository binding drifted/);
});

test("evidence receipt cannot be reused across blind challenge identities", () => {
  const first = request("challenge-1");
  const second = request("challenge-2");
  const evidence = challengeEvidence(first);
  const secondSha = goalSha(second);
  assert.throws(() => parseSemanticChallengeAction(sealed({ challenge_id: "challenge-2", original_goal_sha256: secondSha }), second, evidence), /evidence belongs to another challenge/);
});

test("maintainer findings require exact evidence except explicit unresolved unknowns", () => {
  const active = request();
  const sha = goalSha(active);
  const evidence = challengeEvidence(active);

  assert.throws(() => parseSemanticChallengeAction(sealed({
    original_goal_sha256: sha,
    findings: [{ finding_id: "F-1", category: "risk", statement: "Restart may duplicate mutation.", citations: [] }],
  }), active, evidence), /must cite exact repository evidence/);

  assert.throws(() => parseSemanticChallengeAction(sealed({
    original_goal_sha256: sha,
    findings: [{ finding_id: "F-1", category: "unknown", statement: "No restart ownership evidence has been read yet.", citations: [] }],
    unresolved_questions: [],
  }), active, evidence), /must preserve unresolved questions/);

  const unknown = parseSemanticChallengeAction(sealed({
    original_goal_sha256: sha,
    findings: [{ finding_id: "F-1", category: "unknown", statement: "No restart ownership evidence has been read yet.", citations: [] }],
    unresolved_questions: ["Which durable ledger proves the mutation owner after restart?"],
  }), active, evidence);
  assert.equal(unknown.kind, "semantic_understanding_sealed");
});

test("hallucinated but well-formed citations cannot seal", () => {
  const active = request();
  const sha = goalSha(active);
  const evidence = challengeEvidence(active);
  assert.throws(() => parseSemanticChallengeAction(sealed({
    original_goal_sha256: sha,
    findings: [{
      finding_id: "F-1",
      category: "risk",
      statement: "A plausible-looking but unread file allegedly controls recovery.",
      citations: [{ ...citation(), path: "src/recovery.ts" }],
    }],
  }), active, evidence), /was not observed by the challenger/);
});

test("closed schema rejects verdicts, repair authority, candidate leakage and duplicate findings", () => {
  const active = request();
  const sha = goalSha(active);
  const evidence = challengeEvidence(active);

  assert.throws(() => parseSemanticChallengeAction({ ...sealed({ original_goal_sha256: sha }), verdict: "APPROVE" }, active, evidence), /unexpected field 'verdict'/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: sha, candidate_contract: {} }), active, evidence), /unexpected field 'candidate_contract'/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: sha, repair_operations: [] }), active, evidence), /unexpected field 'repair_operations'/);
  assert.throws(() => parseSemanticChallengeAction(sealed({
    original_goal_sha256: sha,
    findings: [
      { finding_id: "F-1", category: "component", statement: "Session focus is affected.", citations: [citation()] },
      { finding_id: "F-1", category: "risk", statement: "Restart may race focus.", citations: [citation()] },
    ],
  }), active, evidence), /duplicate finding IDs/);
});

test("evidence citations reject non-canonical paths, non-SHA digests and empty regions", () => {
  const active = request();
  const sha = goalSha(active);
  const evidence = challengeEvidence(active);
  for (const badCitation of [
    citation("../secret.txt"),
    citation("src//session.ts"),
    citation("./src/session.ts"),
    { ...citation(), content_sha256: "ABC" },
    { ...citation(), start_byte: 10, end_byte_exclusive: 10 },
  ]) {
    assert.throws(() => parseSemanticChallengeAction(sealed({
      original_goal_sha256: sha,
      findings: [{ finding_id: "F-1", category: "component", statement: "Affected component.", citations: [badCitation] }],
    }), active, evidence));
  }
});
