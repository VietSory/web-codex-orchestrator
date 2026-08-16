import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import { readLatestTrajectoryBoundSemanticChallengeEvidence } from "../src/semantic/challenge-evidence-recovery.js";
import { appendSemanticChallengeTrajectoryEvent } from "../src/semantic/challenge-trajectory-store.js";

test("recovery fails closed when a durable repository observation has no evidence snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-recovery-gap-"));
  const stateDirectory = path.join(root, "state");
  await mkdir(stateDirectory, { recursive: true });
  const request = createSemanticChallengeRequest({
    challengeId: "challenge-orphan-observation",
    repository: { repository_id: "repo-gap", base_branch: "main", base_commit: "a".repeat(40) },
    originalGoal: "Do not silently recover past incomplete semantic evidence.",
  });
  try {
    await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request, sequence: 1, eventType: "challenge_created", idempotencyKey: "create", payload: { created: true } });
    await appendSemanticChallengeTrajectoryEvent({ stateDirectory, request, sequence: 2, eventType: "repository_observation", idempotencyKey: "observe-1", payload: { digest_only: true } });
    await assert.rejects(
      readLatestTrajectoryBoundSemanticChallengeEvidence({ stateDirectory, request }),
      /repository observations without durable evidence snapshots/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
