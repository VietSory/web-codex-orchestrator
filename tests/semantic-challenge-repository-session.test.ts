import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import { SemanticChallengeRepositorySession } from "../src/semantic/challenge-repository-session.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-challenge-"));
  const repositoryPath = path.join(root, "repo");
  const stateDirectory = path.join(root, "state");
  await mkdir(path.join(repositoryPath, "src"), { recursive: true });
  await writeFile(path.join(repositoryPath, "src", "session.ts"), "export const focus = 'current';\n", "utf8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repositoryPath });
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync("git", ["-c", "user.name=WCO Test", "-c", "user.email=wco@example.invalid", "commit", "-q", "-m", "fixture"], { cwd: repositoryPath });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, encoding: "utf8" }).trim();
  const request = createSemanticChallengeRequest({
    challengeId: "challenge-runtime-provenance",
    repository: { repository_id: "repo-runtime", base_branch: "main", base_commit: baseCommit },
    originalGoal: "Preserve current task focus across restart.",
  });
  return { root, repositoryPath, stateDirectory, request };
}

test("challenge repository session builds evidence only from its own exact reads", async () => {
  const value = await fixture();
  try {
    const session = new SemanticChallengeRepositorySession(value);
    assert.throws(() => session.buildEvidence(), /before an exact repository observation/);

    await session.execute({ operation: "summary" });
    const command = { operation: "read" as const, paths: ["src/session.ts"] };
    const delivered = await session.execute(command);
    assert.equal(session.observationCount, 2);

    const deliveredRead = delivered.result as { files: Array<{ path: string }> };
    deliveredRead.files[0]!.path = "src/fabricated.ts";
    command.paths[0] = "src/other.ts";

    const evidence = session.buildEvidence();
    assert.equal(evidence.challenge_id, value.request.challenge_id);
    assert.deepEqual(evidence.repository, value.request.repository);
    assert.equal(evidence.evidence_index.observations.length, 2);
    const read = evidence.evidence_index.observations[1]!;
    assert.equal(read.operation, "read");
    assert.deepEqual(read.command, { operation: "read", paths: ["src/session.ts"] });
    assert.equal(read.result.kind, "read");
    if (read.result.kind === "read") assert.equal(read.result.files[0]!.path, "src/session.ts");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("challenge identity is snapshotted and cannot drift through caller mutation", async () => {
  const value = await fixture();
  try {
    const expectedChallenge = value.request.challenge_id;
    const expectedCommit = value.request.repository.base_commit;
    const session = new SemanticChallengeRepositorySession(value);
    value.request.challenge_id = "mutated-challenge";
    value.request.repository.base_commit = "f".repeat(40);
    const exposed = session.request;
    exposed.challenge_id = "mutated-copy";
    exposed.repository.base_commit = "e".repeat(40);

    await session.execute({ operation: "read", paths: ["src/session.ts"] });
    const evidence = session.buildEvidence();
    assert.equal(evidence.challenge_id, expectedChallenge);
    assert.equal(evidence.repository.base_commit, expectedCommit);
    assert.equal(session.request.challenge_id, expectedChallenge);
    assert.equal(session.request.repository.base_commit, expectedCommit);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("concurrent challenger reads serialize into unique ordered observation identities", async () => {
  const value = await fixture();
  try {
    const session = new SemanticChallengeRepositorySession(value);
    const [first, second] = await Promise.all([
      session.execute({ operation: "summary" }),
      session.execute({ operation: "tree", maximum_paths: 10 }),
    ]);
    assert.deepEqual([first.request_id, second.request_id], ["read-001", "read-002"]);
    const evidence = session.buildEvidence();
    assert.deepEqual(evidence.evidence_index.observations.map((item) => item.sequence), [1, 2]);
    assert.deepEqual(evidence.evidence_index.observations.map((item) => item.request_id), ["read-001", "read-002"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("challenge sessions use distinct evidence ownership for distinct challenge identities", async () => {
  const value = await fixture();
  try {
    const first = new SemanticChallengeRepositorySession(value);
    const secondRequest = createSemanticChallengeRequest({
      challengeId: "challenge-runtime-provenance-2",
      repository: value.request.repository,
      originalGoal: value.request.original_goal,
    });
    const second = new SemanticChallengeRepositorySession({ ...value, request: secondRequest });
    await first.execute({ operation: "read", paths: ["src/session.ts"] });
    await second.execute({ operation: "read", paths: ["src/session.ts"] });
    const firstEvidence = first.buildEvidence();
    const secondEvidence = second.buildEvidence();
    assert.notEqual(firstEvidence.challenge_evidence_sha256, secondEvidence.challenge_evidence_sha256);
    assert.equal(firstEvidence.challenge_id, first.request.challenge_id);
    assert.equal(secondEvidence.challenge_id, secondRequest.challenge_id);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("read-coverage namespace binds the complete repository identity", async () => {
  const value = await fixture();
  try {
    const first = new SemanticChallengeRepositorySession(value);
    const secondRequest = createSemanticChallengeRequest({
      challengeId: value.request.challenge_id,
      repository: { ...value.request.repository, repository_id: "repo-runtime-second" },
      originalGoal: value.request.original_goal,
    });
    const second = new SemanticChallengeRepositorySession({ ...value, request: secondRequest });

    await first.execute({ operation: "read", paths: ["src/session.ts"] });
    await second.execute({ operation: "read", paths: ["src/session.ts"] });

    const scopes = await readdir(path.join(value.stateDirectory, "semantic", "challenge-read-coverage"));
    assert.equal(scopes.length, 2, "repository identity drift must not share durable read-coverage state");
    assert.notEqual(first.buildEvidence().repository.repository_id, second.buildEvidence().repository.repository_id);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
