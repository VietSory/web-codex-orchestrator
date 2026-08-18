import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import { appendSemanticChallengeTrajectoryEvent, readSemanticChallengeTrajectory } from "../src/semantic/challenge-trajectory-store.js";

const REPO = {
  repository_id: "repo-one",
  base_branch: "main",
  base_commit: "a".repeat(40),
};

function request(overrides: Partial<{ challengeId: string; repositoryId: string; goal: string }> = {}) {
  return createSemanticChallengeRequest({
    challengeId: overrides.challengeId ?? "challenge-001",
    repository: { ...REPO, repository_id: overrides.repositoryId ?? REPO.repository_id },
    originalGoal: overrides.goal ?? "Preserve recovery invariants while changing resume semantics.",
  });
}

async function temporaryState(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "wco-semantic-trajectory-"));
}

test("durable semantic trajectory is append-only, digest chained, replay-safe, and payload-redacted", async (t) => {
  const stateDirectory = await temporaryState();
  t.after(async () => { await rm(stateDirectory, { recursive: true, force: true }); });
  const challenge = request();

  const created = await appendSemanticChallengeTrajectoryEvent({
    stateDirectory,
    request: challenge,
    sequence: 1,
    eventType: "challenge_created",
    idempotencyKey: "create-001",
    payload: { prompt_sha256: "b".repeat(64), secret: "SOURCE_BYTES_MUST_NOT_PERSIST" },
  });
  const observed = await appendSemanticChallengeTrajectoryEvent({
    stateDirectory,
    request: challenge,
    sequence: 2,
    eventType: "repository_observation",
    idempotencyKey: "read-001",
    payload: { request_id: "read-001", evidence_sha256: "c".repeat(64) },
  });
  const sealed = await appendSemanticChallengeTrajectoryEvent({
    stateDirectory,
    request: challenge,
    sequence: 3,
    eventType: "understanding_sealed",
    idempotencyKey: "seal-001",
    payload: { understanding_sha256: "d".repeat(64) },
  });

  assert.equal(created.status, "created");
  assert.equal(observed.receipt.previous_receipt_sha256, created.receipt.receipt_sha256);
  assert.equal(sealed.receipt.previous_receipt_sha256, observed.receipt.receipt_sha256);

  const replay = await appendSemanticChallengeTrajectoryEvent({
    stateDirectory,
    request: challenge,
    sequence: 2,
    eventType: "repository_observation",
    idempotencyKey: "read-001",
    payload: { request_id: "read-001", evidence_sha256: "c".repeat(64) },
  });
  assert.equal(replay.status, "replayed");
  assert.equal(replay.receipt.receipt_sha256, observed.receipt.receipt_sha256);

  const receipts = await readSemanticChallengeTrajectory({ stateDirectory, request: challenge });
  assert.deepEqual(receipts.map((receipt) => receipt.sequence), [1, 2, 3]);
  assert.deepEqual(receipts.map((receipt) => receipt.event_type), ["challenge_created", "repository_observation", "understanding_sealed"]);

  const disk = await readFile(created.path, "utf8");
  assert.equal(disk.includes("SOURCE_BYTES_MUST_NOT_PERSIST"), false, "trajectory receipt must persist payload digest, never payload bytes");
});

test("trajectory refuses to seal an understanding before repository evidence was observed", async (t) => {
  const stateDirectory = await temporaryState();
  t.after(async () => { await rm(stateDirectory, { recursive: true, force: true }); });
  const challenge = request({ challengeId: "challenge-shallow-seal" });

  await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 1, eventType: "challenge_created", idempotencyKey: "create", payload: {} });
  await assert.rejects(
    appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 2, eventType: "understanding_sealed", idempotencyKey: "seal", payload: { digest: "unsupported" } }),
    /before repository evidence is observed/i,
  );
  const receipts = await readSemanticChallengeTrajectory({ stateDirectory, request: challenge });
  assert.deepEqual(receipts.map((receipt) => receipt.event_type), ["challenge_created"]);
});

test("trajectory rejects conflicting replay, gaps, forks, recreation and append-after-seal", async (t) => {
  const stateDirectory = await temporaryState();
  t.after(async () => { await rm(stateDirectory, { recursive: true, force: true }); });
  const challenge = request({ challengeId: "challenge-conflict" });

  await assert.rejects(
    appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 2, eventType: "repository_observation", idempotencyKey: "gap", payload: {} }),
    /first event|next contiguous/i,
  );
  await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 1, eventType: "challenge_created", idempotencyKey: "create", payload: { digest: "a" } });
  await assert.rejects(
    appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 1, eventType: "challenge_created", idempotencyKey: "create", payload: { digest: "changed" } }),
    /idempotency replay conflicts/i,
  );
  await assert.rejects(
    appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 1, eventType: "challenge_created", idempotencyKey: "another-create", payload: {} }),
    /sequence already belongs/i,
  );
  await assert.rejects(
    appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 2, eventType: "challenge_created", idempotencyKey: "recreate", payload: {} }),
    /cannot recreate/i,
  );
  await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 2, eventType: "repository_observation", idempotencyKey: "read", payload: { digest: "observed" } });
  await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 3, eventType: "understanding_sealed", idempotencyKey: "seal", payload: { digest: "sealed" } });
  await assert.rejects(
    appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 4, eventType: "repository_observation", idempotencyKey: "late", payload: {} }),
    /already sealed/i,
  );
});

test("writer lock serializes competing same-sequence appends so a trajectory cannot fork", async (t) => {
  const stateDirectory = await temporaryState();
  t.after(async () => { await rm(stateDirectory, { recursive: true, force: true }); });
  const challenge = request({ challengeId: "challenge-race" });
  await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 1, eventType: "challenge_created", idempotencyKey: "create", payload: {} });

  const results = await Promise.allSettled([
    appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 2, eventType: "repository_observation", idempotencyKey: "race-a", payload: { result: "a" } }),
    appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 2, eventType: "repository_observation", idempotencyKey: "race-b", payload: { result: "b" } }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const receipts = await readSemanticChallengeTrajectory({ stateDirectory, request: challenge });
  assert.equal(receipts.length, 2);
  assert.equal(receipts[1]?.sequence, 2);
});

test("challenge/repository/goal bindings isolate durable trajectories", async (t) => {
  const stateDirectory = await temporaryState();
  t.after(async () => { await rm(stateDirectory, { recursive: true, force: true }); });
  const first = request({ challengeId: "same-challenge", repositoryId: "repo-one", goal: "goal one" });
  const second = request({ challengeId: "same-challenge", repositoryId: "repo-two", goal: "goal two" });
  await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: first, sequence: 1, eventType: "challenge_created", idempotencyKey: "create", payload: { identity: 1 } });
  await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: second, sequence: 1, eventType: "challenge_created", idempotencyKey: "create", payload: { identity: 2 } });
  assert.equal((await readSemanticChallengeTrajectory({ stateDirectory, request: first })).length, 1);
  assert.equal((await readSemanticChallengeTrajectory({ stateDirectory, request: second })).length, 1);
});

test("tampered or symlinked receipts fail closed instead of becoming recovery truth", async (t) => {
  const stateDirectory = await temporaryState();
  t.after(async () => { await rm(stateDirectory, { recursive: true, force: true }); });
  const challenge = request({ challengeId: "challenge-tamper" });
  const first = await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 1, eventType: "challenge_created", idempotencyKey: "create", payload: {} });
  const second = await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request: challenge, sequence: 2, eventType: "repository_observation", idempotencyKey: "read", payload: { evidence: "x" } });

  const original = await readFile(second.path, "utf8");
  const parsed = JSON.parse(original) as Record<string, unknown>;
  parsed.payload_sha256 = "f".repeat(64);
  await writeFile(second.path, `${JSON.stringify(parsed)}\n`, "utf8");
  await assert.rejects(readSemanticChallengeTrajectory({ stateDirectory, request: challenge }), /receipt digest is invalid/i);

  await writeFile(second.path, original, "utf8");
  await unlink(second.path);
  await symlink(first.path, second.path);
  await assert.rejects(readSemanticChallengeTrajectory({ stateDirectory, request: challenge }), /path is unsafe/i);
});
