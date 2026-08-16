import { contentDigest, parseRepositoryCommand, type RepositoryCommandResult } from "../web-bridge/contracts.js";
import type { WebBridge } from "../web-bridge/web-bridge.js";
import { isSemanticChallengeAwareWebBridge, type SemanticChallengeTransport } from "./challenge-aware-web-bridge.js";
import {
  createSemanticChallengeRequest,
  parseSemanticChallengeAction,
  type SemanticChallengeRequest,
  type SemanticUnderstandingEnvelope,
} from "./blind-challenge.js";
import { SemanticChallengeRepositorySession } from "./challenge-repository-session.js";
import {
  appendSemanticChallengeTrajectoryEvent,
  readSemanticChallengeTrajectory,
} from "./challenge-trajectory-store.js";

const MAX_REMOTE_ACTIONS = 128;

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

/**
 * Run one independent blind semantic challenge in shadow mode.
 *
 * The transport has no mutation/review authority. Repository evidence can only
 * enter through SemanticChallengeRepositorySession, and every accepted remote
 * action is durably represented by the digest-only trajectory store. The
 * caller decides whether failure is fail-open; this function itself fails
 * closed on provenance, sequencing, evidence, or transport inconsistency.
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
  const repository = new SemanticChallengeRepositorySession({
    request,
    repositoryPath: options.repositoryPath,
    stateDirectory: options.stateDirectory,
  });

  const prior = await readSemanticChallengeTrajectory({ stateDirectory: options.stateDirectory, request });
  if (prior.length === 0) {
    await appendSemanticChallengeTrajectoryEvent({
      stateDirectory: options.stateDirectory,
      request,
      sequence: 1,
      eventType: "challenge_created",
      idempotencyKey: "challenge-created",
      payload: { request_sha256: contentDigest(request) },
    });
  } else if (prior[0]?.event_type !== "challenge_created" || prior.at(-1)?.event_type === "understanding_sealed") {
    throw new Error("semantic challenge shadow trajectory is not resumable.");
  }

  const identity = await options.transport.createSemanticChallengeJob(request, `challenge-${request.challenge_id}`);
  if (!identity?.job_id) throw new Error("semantic challenge transport returned an invalid job identity.");

  let remoteSequence = 0;
  let remoteActions = 0;
  for (; remoteActions < MAX_REMOTE_ACTIONS; remoteActions += 1) {
    const action = await options.transport.waitForSemanticChallengeAction(identity.job_id, remoteSequence, options.signal);
    if (!action) throw new Error("semantic challenge transport ended before sealed understanding.");
    if (!Number.isSafeInteger(action.sequence) || action.sequence <= remoteSequence) throw new Error("semantic challenge remote action sequence did not advance.");
    remoteSequence = action.sequence;

    if (action.type === "repository_command") {
      const parsed = parseSemanticChallengeAction({ kind: "repository_command", command: parseRepositoryCommand(action.command) }, request);
      if (parsed.kind !== "repository_command") throw new Error("semantic challenge repository action changed kind during validation.");
      const delivered = await repository.execute(parsed.command);
      await options.transport.submitSemanticChallengeRepositoryResult(
        identity.job_id,
        delivered as RepositoryCommandResult,
        `result-${delivered.request_id}`,
      );
      const trajectory = await readSemanticChallengeTrajectory({ stateDirectory: options.stateDirectory, request });
      await appendSemanticChallengeTrajectoryEvent({
        stateDirectory: options.stateDirectory,
        request,
        sequence: trajectory.length + 1,
        eventType: "repository_observation",
        idempotencyKey: `observation-${trajectory.length + 1}`,
        payload: {
          remote_sequence: action.sequence,
          request_id: delivered.request_id,
          command_sha256: contentDigest(parsed.command),
          result_sha256: contentDigest(delivered.result),
        },
      });
      continue;
    }

    const evidence = repository.buildEvidence();
    const parsed = parseSemanticChallengeAction({ kind: "semantic_understanding_sealed", envelope: action.envelope }, request, evidence);
    if (parsed.kind !== "semantic_understanding_sealed") throw new Error("semantic challenge sealed action changed kind during validation.");
    const received = await options.transport.receiveSemanticUnderstanding(identity.job_id);
    if (!received || !sameUnderstanding(received, parsed.envelope)) throw new Error("semantic challenge transport sealed understanding does not match its received understanding.");
    const trajectory = await readSemanticChallengeTrajectory({ stateDirectory: options.stateDirectory, request });
    await appendSemanticChallengeTrajectoryEvent({
      stateDirectory: options.stateDirectory,
      request,
      sequence: trajectory.length + 1,
      eventType: "understanding_sealed",
      idempotencyKey: `understanding-${trajectory.length + 1}`,
      payload: { understanding_sha256: contentDigest(parsed.envelope), evidence_sha256: evidence.challenge_evidence_sha256 },
    });
    const finalTrajectory = await readSemanticChallengeTrajectory({ stateDirectory: options.stateDirectory, request });
    return {
      challenge_id: request.challenge_id,
      job_id: identity.job_id,
      remote_actions: remoteActions + 1,
      repository_observations: repository.observationCount,
      trajectory_events: finalTrajectory.length,
      understanding: parsed.envelope,
    };
  }
  throw new Error(`semantic challenge exceeded its ${MAX_REMOTE_ACTIONS}-action bound.`);
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
