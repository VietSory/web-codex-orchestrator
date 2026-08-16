import crypto from "node:crypto";
import path from "node:path";
import type { RepositoryCommand } from "../web-bridge/contracts.js";
import { ContentAddressedContextCache } from "../web-bridge/context-cache.js";
import { ReadCoverageStore } from "../web-bridge/read-coverage-store.js";
import { ExactRepositoryReadService } from "../web-bridge/repo-read-service.js";
import { buildSemanticChallengeEvidence, createSemanticChallengeRequest, type SemanticChallengeEvidence, type SemanticChallengeRequest } from "./blind-challenge.js";
import type { SemanticEvidenceObservationInput } from "./evidence-index.js";

const MAX_OBSERVATIONS = 128;

/**
 * Challenge-owned repository reader.
 *
 * The only way to add evidence to this session is to execute the exact bounded
 * repository reader owned by the session. Callers cannot inject arbitrary raw
 * results or reuse Web-A shadow observations. Challenge identity, commands and
 * results are snapshotted internally and execution is serialized so concurrent
 * callers cannot reuse sequence/request identities.
 */
export class SemanticChallengeRepositorySession {
  private readonly reader: ExactRepositoryReadService;
  private readonly observations: SemanticEvidenceObservationInput[] = [];
  private readonly runtimeId: string;
  private readonly requestValue: SemanticChallengeRequest;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: {
    request: SemanticChallengeRequest;
    repositoryPath: string;
    stateDirectory: string;
  }) {
    this.requestValue = createSemanticChallengeRequest({
      challengeId: options.request.challenge_id,
      repository: options.request.repository,
      originalGoal: options.request.original_goal,
    });
    this.runtimeId = `semantic-${crypto.createHash("sha256").update(this.requestValue.challenge_id).digest("hex").slice(0, 32)}`;
    const scope = crypto.createHash("sha256").update(`${this.requestValue.challenge_id}\0${this.requestValue.repository.base_commit}`).digest("hex");
    const coverage = new ReadCoverageStore(path.join(options.stateDirectory, "semantic", "challenge-read-coverage", scope));
    const cache = new ContentAddressedContextCache(path.join(options.stateDirectory, "cache", "semantic-challenge-context"));
    this.reader = new ExactRepositoryReadService(options.repositoryPath, this.requestValue.repository, coverage, {}, cache);
  }

  get request(): SemanticChallengeRequest {
    return structuredClone(this.requestValue);
  }

  get observationCount(): number {
    return this.observations.length;
  }

  async execute(command: RepositoryCommand): Promise<{ request_id: string; result: unknown }> {
    const commandSnapshot = structuredClone(command);
    const task = this.pending.then(async () => {
      if (this.observations.length >= MAX_OBSERVATIONS) throw new Error(`semantic challenge repository observation limit ${MAX_OBSERVATIONS} reached.`);
      const sequence = this.observations.length + 1;
      const request_id = `read-${sequence.toString().padStart(3, "0")}`;
      const result = await this.reader.execute(this.runtimeId, request_id, commandSnapshot);
      this.observations.push({
        sequence,
        request_id,
        command: commandSnapshot,
        result: structuredClone(result),
      });
      return { request_id, result };
    });
    this.pending = task.then(() => undefined, () => undefined);
    return await task;
  }

  buildEvidence(): SemanticChallengeEvidence {
    if (this.observations.length === 0) throw new Error("semantic challenge cannot build evidence before an exact repository observation.");
    return buildSemanticChallengeEvidence({ request: this.requestValue, observations: this.observations });
  }
}
