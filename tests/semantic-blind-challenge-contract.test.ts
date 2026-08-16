import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticChallengeRequest, parseSemanticChallengeAction, semanticChallengePrompt } from "../src/semantic/blind-challenge.js";

const repository = {
  repository_id: "repo-1",
  base_branch: "main",
  base_commit: "a".repeat(40),
};

function request() {
  return createSemanticChallengeRequest({
    challengeId: "challenge-1",
    repository,
    originalGoal: "Make task continuation safe across restart without silently changing mutation focus.",
  });
}

function citation(path = "src/session.ts") {
  return {
    path,
    content_sha256: "b".repeat(64),
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

test("sealed understanding binds exact challenge, repository and original goal", () => {
  const active = request();
  // Obtain the exact digest only through the public prompt contract to avoid duplicating digest implementation in the test.
  const goalSha = semanticChallengePrompt(active).match(/Original goal SHA-256: ([a-f0-9]{64})/)?.[1];
  assert.ok(goalSha);
  const parsed = parseSemanticChallengeAction(sealed({ original_goal_sha256: goalSha }), active);
  assert.equal(parsed.kind, "semantic_understanding_sealed");

  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: "d".repeat(64) }), active), /exact original goal/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: goalSha, challenge_id: "challenge-other" }), active), /another challenge/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: goalSha, repository: { ...repository, base_commit: "e".repeat(40) } }), active), /repository binding drifted/);
});

test("maintainer findings require exact evidence except unresolved unknowns", () => {
  const active = request();
  const goalSha = semanticChallengePrompt(active).match(/Original goal SHA-256: ([a-f0-9]{64})/)?.[1];
  assert.ok(goalSha);

  assert.throws(() => parseSemanticChallengeAction(sealed({
    original_goal_sha256: goalSha,
    findings: [{ finding_id: "F-1", category: "risk", statement: "Restart may duplicate mutation.", citations: [] }],
  }), active), /must cite exact repository evidence/);

  const unknown = parseSemanticChallengeAction(sealed({
    original_goal_sha256: goalSha,
    findings: [{ finding_id: "F-1", category: "unknown", statement: "No restart ownership evidence has been read yet.", citations: [] }],
    unresolved_questions: ["Which durable ledger proves the mutation owner after restart?"],
  }), active);
  assert.equal(unknown.kind, "semantic_understanding_sealed");
});

test("closed schema rejects verdicts, repair authority, candidate leakage and duplicate findings", () => {
  const active = request();
  const goalSha = semanticChallengePrompt(active).match(/Original goal SHA-256: ([a-f0-9]{64})/)?.[1];
  assert.ok(goalSha);

  assert.throws(() => parseSemanticChallengeAction({ ...sealed({ original_goal_sha256: goalSha }), verdict: "APPROVE" }, active), /unexpected field 'verdict'/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: goalSha, candidate_contract: {} }), active), /unexpected field 'candidate_contract'/);
  assert.throws(() => parseSemanticChallengeAction(sealed({ original_goal_sha256: goalSha, repair_operations: [] }), active), /unexpected field 'repair_operations'/);
  assert.throws(() => parseSemanticChallengeAction(sealed({
    original_goal_sha256: goalSha,
    findings: [
      { finding_id: "F-1", category: "component", statement: "Session focus is affected.", citations: [citation()] },
      { finding_id: "F-1", category: "risk", statement: "Restart may race focus.", citations: [citation("src/recovery.ts")] },
    ],
  }), active), /duplicate finding IDs/);
});

test("evidence citations reject traversal, non-SHA digests and empty regions", () => {
  const active = request();
  const goalSha = semanticChallengePrompt(active).match(/Original goal SHA-256: ([a-f0-9]{64})/)?.[1];
  assert.ok(goalSha);
  for (const badCitation of [
    citation("../secret.txt"),
    { ...citation(), content_sha256: "ABC" },
    { ...citation(), start_byte: 10, end_byte_exclusive: 10 },
  ]) {
    assert.throws(() => parseSemanticChallengeAction(sealed({
      original_goal_sha256: goalSha,
      findings: [{ finding_id: "F-1", category: "component", statement: "Affected component.", citations: [badCitation] }],
    }), active));
  }
});
