import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import { persistSemanticChallengeEvidenceSnapshot, readLatestSemanticChallengeEvidenceSnapshot } from "../src/semantic/challenge-evidence-store.js";
import { SemanticChallengeRepositorySession } from "../src/semantic/challenge-repository-session.js";
import { appendSemanticChallengeTrajectoryEvent } from "../src/semantic/challenge-trajectory-store.js";

const SECRET = "semantic-recovery-source-secret";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-evidence-recovery-"));
  const repositoryPath = path.join(root, "repo");
  const stateDirectory = path.join(root, "state");
  await mkdir(path.join(repositoryPath, "src"), { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(repositoryPath, "src", "state.ts"), `export const value = '${SECRET}';\n`, "utf8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repositoryPath });
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync("git", ["-c", "user.name=WCO Test", "-c", "user.email=wco@example.invalid", "commit", "-q", "-m", "fixture"], { cwd: repositoryPath });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath, encoding: "utf8" }).trim();
  const request = createSemanticChallengeRequest({
    challengeId: "challenge-evidence-recovery",
    repository: { repository_id: "repo-recovery", base_branch: "main", base_commit: baseCommit },
    originalGoal: "Preserve recovery authority while improving semantic understanding.",
  });
  return { root, repositoryPath, stateDirectory, request };
}

async function createTrajectory(value: Awaited<ReturnType<typeof fixture>>) {
  await appendSemanticChallengeTrajectoryEvent({
    stateDirectory: value.stateDirectory,
    request: value.request,
    sequence: 1,
    eventType: "challenge_created",
    idempotencyKey: "create",
    payload: { challenge: value.request.challenge_id },
  });
}

async function observeAndPersist(value: Awaited<ReturnType<typeof fixture>>, session: SemanticChallengeRepositorySession, index: number) {
  await session.execute({ operation: "read", paths: ["src/state.ts"] });
  const trajectory = await appendSemanticChallengeTrajectoryEvent({
    stateDirectory: value.stateDirectory,
    request: value.request,
    sequence: index + 1,
    eventType: "repository_observation",
    idempotencyKey: `observe-${index}`,
    payload: { observation: index },
  });
  return await persistSemanticChallengeEvidenceSnapshot({
    stateDirectory: value.stateDirectory,
    request: value.request,
    trajectoryReceiptSha256: trajectory.receipt.receipt_sha256,
    evidence: session.buildEvidence(),
  });
}

test("challenge evidence survives restart without persisting repository source bytes", async () => {
  const value = await fixture();
  try {
    await createTrajectory(value);
    const session = new SemanticChallengeRepositorySession(value);
    const persisted = await observeAndPersist(value, session, 1);
    const disk = await readFile(persisted.path, "utf8");
    assert.equal(disk.includes(SECRET), false, "recoverable evidence must remain byte-stripped");
    assert.equal(disk.includes("content_base64"), false, "recoverable evidence must not persist relay source bytes");

    const recoveredRequest = createSemanticChallengeRequest({
      challengeId: value.request.challenge_id,
      repository: value.request.repository,
      originalGoal: value.request.original_goal,
    });
    const recovered = await readLatestSemanticChallengeEvidenceSnapshot({ stateDirectory: value.stateDirectory, request: recoveredRequest });
    assert.ok(recovered);
    assert.equal(recovered.observation_count, 1);
    assert.equal(recovered.evidence.challenge_evidence_sha256, persisted.snapshot.evidence.challenge_evidence_sha256);
    assert.equal(recovered.trajectory_receipt_sha256, persisted.snapshot.trajectory_receipt_sha256);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("snapshot replay is exact and cannot rebind one observation to another trajectory receipt", async () => {
  const value = await fixture();
  try {
    await createTrajectory(value);
    const session = new SemanticChallengeRepositorySession(value);
    const first = await observeAndPersist(value, session, 1);
    const replay = await persistSemanticChallengeEvidenceSnapshot({
      stateDirectory: value.stateDirectory,
      request: value.request,
      trajectoryReceiptSha256: first.snapshot.trajectory_receipt_sha256,
      evidence: session.buildEvidence(),
    });
    assert.equal(replay.status, "replayed");
    await assert.rejects(
      persistSemanticChallengeEvidenceSnapshot({
        stateDirectory: value.stateDirectory,
        request: value.request,
        trajectoryReceiptSha256: "f".repeat(64),
        evidence: session.buildEvidence(),
      }),
      /append one exact observation at a time/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("recoverable snapshots form a contiguous immutable chain and reject tamper", async () => {
  const value = await fixture();
  try {
    await createTrajectory(value);
    const session = new SemanticChallengeRepositorySession(value);
    const first = await observeAndPersist(value, session, 1);
    const second = await observeAndPersist(value, session, 2);
    assert.equal(second.snapshot.previous_snapshot_sha256, first.snapshot.snapshot_sha256);
    assert.equal(second.snapshot.observation_count, 2);

    const corrupted = JSON.parse(await readFile(first.path, "utf8")) as Record<string, unknown>;
    corrupted.original_goal_sha256 = "0".repeat(64);
    await writeFile(first.path, `${JSON.stringify(corrupted)}\n`, "utf8");
    await assert.rejects(
      readLatestSemanticChallengeEvidenceSnapshot({ stateDirectory: value.stateDirectory, request: value.request }),
      /original goal binding drifted|snapshot digest is invalid/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("recovery refuses the same challenge and repository under a different original goal", async () => {
  const value = await fixture();
  try {
    await createTrajectory(value);
    const session = new SemanticChallengeRepositorySession(value);
    await observeAndPersist(value, session, 1);
    const drifted = createSemanticChallengeRequest({
      challengeId: value.request.challenge_id,
      repository: value.request.repository,
      originalGoal: "A different user goal must not inherit prior semantic evidence.",
    });
    await assert.rejects(
      readLatestSemanticChallengeEvidenceSnapshot({ stateDirectory: value.stateDirectory, request: drifted }),
      /original goal binding drifted/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
