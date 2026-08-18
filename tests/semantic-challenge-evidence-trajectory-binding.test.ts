import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSemanticChallengeRequest } from "../src/semantic/blind-challenge.js";
import {
  persistTrajectoryBoundSemanticChallengeEvidence,
  readLatestTrajectoryBoundSemanticChallengeEvidence,
  semanticChallengeEvidenceTrajectoryPayload,
} from "../src/semantic/challenge-evidence-recovery.js";
import { buildGoalBoundSemanticChallengeEvidence } from "../src/semantic/challenge-goal-bound-evidence.js";
import { appendSemanticChallengeTrajectoryEvent } from "../src/semantic/challenge-trajectory-store.js";

const repository = { repository_id: "repo-trajectory-bound", base_branch: "main", base_commit: "a".repeat(40) };
const bytes = Buffer.from("trajectory-bound semantic evidence");
const contentSha = crypto.createHash("sha256").update(bytes).digest("hex");

function request(id = "challenge-trajectory-bound", originalGoal = "Preserve exact recovery semantics while improving understanding.") {
  return createSemanticChallengeRequest({ challengeId: id, repository, originalGoal });
}

function observations() {
  return [{
    sequence: 1,
    request_id: "read-001",
    command: { operation: "read" as const, regions: [{ path: "src/recovery.ts", start_byte: 0, end_byte_exclusive: bytes.length }] },
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

function goalBoundEvidence(active: ReturnType<typeof request>) {
  return buildGoalBoundSemanticChallengeEvidence({ request: active, observations: observations() });
}

async function stateRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-trajectory-binding-"));
  const stateDirectory = path.join(root, "state");
  await mkdir(stateDirectory, { recursive: true });
  return { root, stateDirectory };
}

async function trajectoryFor(stateDirectory: string, active: ReturnType<typeof request>, currentEvidence: ReturnType<typeof goalBoundEvidence>, payload = semanticChallengeEvidenceTrajectoryPayload(active, currentEvidence)) {
  await appendSemanticChallengeTrajectoryEvent({
    stateDirectory,
    request: active,
    sequence: 1,
    eventType: "challenge_created",
    idempotencyKey: "create",
    payload: { challenge: active.challenge_id },
  });
  return await appendSemanticChallengeTrajectoryEvent({
    stateDirectory,
    request: active,
    sequence: 2,
    eventType: "repository_observation",
    idempotencyKey: "observe-1",
    payload,
  });
}

test("trajectory-bound recovery re-attests the exact repository observation receipt", async () => {
  const state = await stateRoot();
  try {
    const active = request();
    const currentEvidence = goalBoundEvidence(active);
    const trajectory = await trajectoryFor(state.stateDirectory, active, currentEvidence);
    const persisted = await persistTrajectoryBoundSemanticChallengeEvidence({
      stateDirectory: state.stateDirectory,
      request: active,
      goalBoundEvidence: currentEvidence,
      trajectoryReceipt: trajectory.receipt,
    });
    assert.equal(persisted.snapshot.trajectory_receipt_sha256, trajectory.receipt.receipt_sha256);
    const recovered = await readLatestTrajectoryBoundSemanticChallengeEvidence({ stateDirectory: state.stateDirectory, request: active });
    assert.ok(recovered);
    assert.equal(recovered.evidence.challenge_evidence_sha256, currentEvidence.evidence.challenge_evidence_sha256);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("trajectory payload must bind the exact goal-bound challenge evidence digest", async () => {
  const state = await stateRoot();
  try {
    const active = request("challenge-wrong-payload");
    const currentEvidence = goalBoundEvidence(active);
    const trajectory = await trajectoryFor(state.stateDirectory, active, currentEvidence, { goal_bound_evidence_sha256: "f".repeat(64), challenge_evidence_sha256: currentEvidence.evidence.challenge_evidence_sha256, observation_count: 1 });
    await assert.rejects(
      persistTrajectoryBoundSemanticChallengeEvidence({ stateDirectory: state.stateDirectory, request: active, goalBoundEvidence: currentEvidence, trajectoryReceipt: trajectory.receipt }),
      /payload does not bind the exact goal-bound evidence snapshot/,
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("goal-bound evidence from another original goal cannot be rebound into this recovery trajectory", async () => {
  const state = await stateRoot();
  try {
    const active = request("challenge-goal-drift", "Goal B");
    const stale = goalBoundEvidence(request("challenge-goal-drift", "Goal A"));
    const trajectory = await trajectoryFor(state.stateDirectory, active, goalBoundEvidence(active));
    await assert.rejects(
      persistTrajectoryBoundSemanticChallengeEvidence({ stateDirectory: state.stateDirectory, request: active, goalBoundEvidence: stale, trajectoryReceipt: trajectory.receipt }),
      /original goal drifted|digest is invalid/,
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("concurrent identical snapshot writers serialize instead of forking durable history", async () => {
  const state = await stateRoot();
  try {
    const active = request("challenge-concurrent-snapshot");
    const currentEvidence = goalBoundEvidence(active);
    const trajectory = await trajectoryFor(state.stateDirectory, active, currentEvidence);
    const results = await Promise.all([
      persistTrajectoryBoundSemanticChallengeEvidence({ stateDirectory: state.stateDirectory, request: active, goalBoundEvidence: currentEvidence, trajectoryReceipt: trajectory.receipt }),
      persistTrajectoryBoundSemanticChallengeEvidence({ stateDirectory: state.stateDirectory, request: active, goalBoundEvidence: currentEvidence, trajectoryReceipt: trajectory.receipt }),
    ]);
    assert.deepEqual(new Set(results.map((item) => item.status)), new Set(["created", "replayed"]));
    assert.equal(results[0]!.snapshot.snapshot_sha256, results[1]!.snapshot.snapshot_sha256);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
