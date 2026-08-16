import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { acquireTicketFileLock, TicketFileLockError, type TicketFileLockHandle } from "../shared/ticket-file-lock.js";
import { contentDigest, parseRepositoryCommand, WEB_BRIDGE_PROTOCOL_VERSION, type RepositoryCommandResult } from "../web-bridge/contracts.js";
import type { WebBridge } from "../web-bridge/web-bridge.js";
import { isSemanticChallengeAwareWebBridge, type SemanticChallengeTransport } from "./challenge-aware-web-bridge.js";
import {
  createSemanticChallengeRequest,
  parseSemanticChallengeAction,
  type SemanticChallengeRequest,
  type SemanticUnderstandingEnvelope,
} from "./blind-challenge.js";
import {
  persistTrajectoryBoundSemanticChallengeEvidence,
  readLatestTrajectoryBoundSemanticChallengeEvidence,
  semanticChallengeEvidenceTrajectoryPayload,
} from "./challenge-evidence-recovery.js";
import { SemanticChallengeRepositorySession } from "./challenge-repository-session.js";
import { appendSemanticChallengeTrajectoryEvent, readSemanticChallengeTrajectory } from "./challenge-trajectory-store.js";

const MAX_REMOTE_ACTIONS = 128;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface SemanticChallengeShadowResult {
  challenge_id: string;
  job_id: string;
  remote_actions: number;
  repository_observations: number;
  trajectory_events: number;
  understanding: SemanticUnderstandingEnvelope;
}

function sameUnderstanding(left: SemanticUnderstandingEnvelope, right: SemanticUnderstandingEnvelope): boolean {
  return contentDigest(left) === contentDigest(right);
}

async function assertSafeDirectory(target: string): Promise<void> {
  const absolute = path.resolve(target);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error("semantic challenge execution lock ancestry is unsafe.");
}

async function ensureChallengeExecutionLockDirectory(stateRoot: string, scope: string): Promise<string> {
  let current = stateRoot;
  for (const component of ["bridge", "semantic-challenge-execution-locks", scope]) {
    await assertSafeDirectory(current);
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertSafeDirectory(current);
  }
  return current;
}

async function acquireChallengeExecutionLock(stateDirectory: string, request: SemanticChallengeRequest): Promise<TicketFileLockHandle> {
  const stateRoot = path.resolve(stateDirectory);
  await assertSafeDirectory(stateRoot);
  const scope = contentDigest({ repository_id: request.repository.repository_id, challenge_id: request.challenge_id });
  const directory = await ensureChallengeExecutionLockDirectory(stateRoot, scope);
  try {
    return await acquireTicketFileLock(directory, { timeoutMs: 0, pollMs: 25 });
  } catch (error) {
    if (error instanceof TicketFileLockError) {
      if (error.code === "TICKET_LOCKED") throw new Error("semantic challenge execution is already active.");
      throw new Error(`semantic challenge execution lock is invalid: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Run one independent blind semantic challenge in shadow mode.
 *
 * Repository observations are owned by SemanticChallengeRepositorySession and
 * must become both a digest-chained trajectory receipt and an immutable,
 * byte-stripped evidence snapshot before another remote action can be accepted.
 * Sealing validates citations against the latest durable evidence snapshot, not
 * merely against memory-only evidence. Transport-owned objects are never kept
 * as mutable internal authority across an await boundary.
 */
export async function runSemanticChallengeShadow(options: {
  transport: SemanticChallengeTransport;
  request: SemanticChallengeRequest;
  repositoryPath: string;
  stateDirectory: string;
  signal?: AbortSignal;
}): Promise<SemanticChallengeShadowResult> {
  const request = createSemanticChallengeRequest({
    challengeId: options.request.challenge_id,
    repository: options.request.repository,
    originalGoal: options.request.original_goal,
  });
  const executionLock = await acquireChallengeExecutionLock(options.stateDirectory, request);
  try {
    const prior = await readSemanticChallengeTrajectory({ stateDirectory: options.stateDirectory, request });
    if (prior.length > 0) throw new Error("semantic challenge shadow cannot replay a prior trajectory without exact provider and evidence state.");

    const repository = new SemanticChallengeRepositorySession({
      request,
      repositoryPath: options.repositoryPath,
      stateDirectory: options.stateDirectory,
    });
    await appendSemanticChallengeTrajectoryEvent({
      stateDirectory: options.stateDirectory,
      request,
      sequence: 1,
      eventType: "challenge_created",
      idempotencyKey: "challenge-created",
      payload: { request_sha256: contentDigest(request) },
    });

    const identity = await options.transport.createSemanticChallengeJob(structuredClone(request), `challenge-${request.challenge_id}`);
    if (identity?.protocol_version !== WEB_BRIDGE_PROTOCOL_VERSION || !SAFE_REQUEST_ID.test(identity.job_id)) throw new Error("semantic challenge transport returned an invalid job identity.");
    const jobId = identity.job_id;

    let remoteSequence = 0;
    let remoteActions = 0;
    const seenRequestIds = new Set<string>();
    for (; remoteActions < MAX_REMOTE_ACTIONS; remoteActions += 1) {
      const remoteAction = await options.transport.waitForSemanticChallengeAction(jobId, remoteSequence, options.signal);
      if (!remoteAction) throw new Error("semantic challenge transport ended before sealed understanding.");
      const action = structuredClone(remoteAction);
      if (!Number.isSafeInteger(action.sequence) || action.sequence !== remoteSequence + 1) throw new Error("semantic challenge remote action sequence must be contiguous.");
      remoteSequence = action.sequence;

      if (action.type === "repository_command") {
        if (!SAFE_REQUEST_ID.test(action.request_id)) throw new Error("semantic challenge remote request identity is invalid.");
        if (seenRequestIds.has(action.request_id)) throw new Error("semantic challenge remote request identity was reused.");
        seenRequestIds.add(action.request_id);
        const parsed = parseSemanticChallengeAction({ kind: "repository_command", command: parseRepositoryCommand(action.command) }, request);
        if (parsed.kind !== "repository_command") throw new Error("semantic challenge repository action changed kind during validation.");

        const delivered = await repository.execute(parsed.command);
        const transportResult = { request_id: action.request_id, result: delivered.result } as RepositoryCommandResult;
        await options.transport.submitSemanticChallengeRepositoryResult(jobId, transportResult, `result-${action.request_id}`);

        const goalBoundEvidence = repository.buildGoalBoundEvidence();
        const trajectory = await readSemanticChallengeTrajectory({ stateDirectory: options.stateDirectory, request });
        const observation = await appendSemanticChallengeTrajectoryEvent({
          stateDirectory: options.stateDirectory,
          request,
          sequence: trajectory.length + 1,
          eventType: "repository_observation",
          idempotencyKey: `observation-${trajectory.length + 1}`,
          payload: semanticChallengeEvidenceTrajectoryPayload(request, goalBoundEvidence),
        });
        await persistTrajectoryBoundSemanticChallengeEvidence({
          stateDirectory: options.stateDirectory,
          request,
          goalBoundEvidence,
          trajectoryReceipt: observation.receipt,
        });
        continue;
      }

      const inMemoryEvidence = repository.buildEvidence();
      const durableEvidence = await readLatestTrajectoryBoundSemanticChallengeEvidence({ stateDirectory: options.stateDirectory, request });
      if (!durableEvidence || durableEvidence.evidence.challenge_evidence_sha256 !== inMemoryEvidence.challenge_evidence_sha256) {
        throw new Error("semantic challenge cannot seal without exact latest durable challenge evidence.");
      }
      const parsed = parseSemanticChallengeAction({ kind: "semantic_understanding_sealed", envelope: action.envelope }, request, durableEvidence.evidence);
      if (parsed.kind !== "semantic_understanding_sealed") throw new Error("semantic challenge sealed action changed kind during validation.");
      const received = await options.transport.receiveSemanticUnderstanding(jobId);
      if (!received || !sameUnderstanding(structuredClone(received), parsed.envelope)) throw new Error("semantic challenge transport sealed understanding does not match its received understanding.");
      const trajectory = await readSemanticChallengeTrajectory({ stateDirectory: options.stateDirectory, request });
      await appendSemanticChallengeTrajectoryEvent({
        stateDirectory: options.stateDirectory,
        request,
        sequence: trajectory.length + 1,
        eventType: "understanding_sealed",
        idempotencyKey: `understanding-${trajectory.length + 1}`,
        payload: { understanding_sha256: contentDigest(parsed.envelope), evidence_sha256: durableEvidence.evidence.challenge_evidence_sha256 },
      });
      const finalTrajectory = await readSemanticChallengeTrajectory({ stateDirectory: options.stateDirectory, request });
      return {
        challenge_id: request.challenge_id,
        job_id: jobId,
        remote_actions: remoteActions + 1,
        repository_observations: repository.observationCount,
        trajectory_events: finalTrajectory.length,
        understanding: parsed.envelope,
      };
    }
    throw new Error(`semantic challenge exceeded its ${MAX_REMOTE_ACTIONS}-action bound.`);
  } finally {
    await executionLock.release();
  }
}

/** Run only when a concrete WebBridge exposes the complete optional capability. */
export async function runSemanticChallengeShadowIfSupported(options: {
  bridge: WebBridge;
  request: SemanticChallengeRequest;
  repositoryPath: string;
  stateDirectory: string;
  signal?: AbortSignal;
}): Promise<SemanticChallengeShadowResult | null> {
  if (!isSemanticChallengeAwareWebBridge(options.bridge)) return null;
  return await runSemanticChallengeShadow({
    transport: options.bridge,
    request: options.request,
    repositoryPath: options.repositoryPath,
    stateDirectory: options.stateDirectory,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
