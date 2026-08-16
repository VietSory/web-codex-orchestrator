import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
    await assert.rejects(async () => session.buildEvidence(), /before an exact repository observation/);

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
    assert.equal(firstEvidence.challenge_id, value.request.challenge_id);
    assert.equal(secondEvidence.challenge_id, secondRequest.challenge_id);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
