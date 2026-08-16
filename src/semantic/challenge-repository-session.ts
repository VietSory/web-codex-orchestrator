import crypto from "node:crypto";
import path from "node:path";
import type { RepositoryCommand } from "../web-bridge/contracts.js";
import { ContentAddressedContextCache } from "../web-bridge/context-cache.js";
import { ReadCoverageStore } from "../web-bridge/read-coverage-store.js";
import { ExactRepositoryReadService } from "../web-bridge/repo-read-service.js";
import { buildSemanticChallengeEvidence, type SemanticChallengeEvidence, type SemanticChallengeRequest } from "./blind-challenge.js";
import type { SemanticEvidenceObservationInput } from "./evidence-index.js";

const MAX_OBSERVATIONS = 128;

/**
 * Challenge-owned repository reader.
 *
 * The only way to add evidence to this session is to execute the exact bounded
 * repository reader owned by the session. Callers cannot inject arbitrary raw
 * results or reuse Web-A shadow observations. This is the runtime provenance
 * boundary required by the blind challenger contract.
 */
export class SemanticChallengeRepositorySession {
  private readonly reader: ExactRepositoryReadService;
  private readonly observations: SemanticEvidenceObservationInput[] = [];
  private readonly runtimeId: string;

  constructor(options: {
    request: SemanticChallengeRequest;
    repositoryPath: string;
    stateDirectory: string;
  }) {
    this.request = options.request;
    this.runtimeId = `semantic-${crypto.createHash("sha256").update(options.request.challenge_id).digest("hex").slice(0, 32)}`;
    const scope = crypto.createHash("sha256").update(`${options.request.challenge_id}\0${options.request.repository.base_commit}`).digest("hex");
    const coverage = new ReadCoverageStore(path.join(options.stateDirectory, "semantic", "challenge-read-coverage", scope));
    const cache = new ContentAddressedContextCache(path.join(options.stateDirectory, "cache", "semantic-challenge-context"));
    this.reader = new ExactRepositoryReadService(options.repositoryPath, options.request.repository, coverage, {}, cache);
  }

  readonly request: SemanticChallengeRequest;

  get observationCount(): number {
    return this.observations.length;
  }

  async execute(command: RepositoryCommand): Promise<{ request_id: string; result: unknown }> {
    if (this.observations.length >= MAX_OBSERVATIONS) throw new Error(`semantic challenge repository observation limit ${MAX_OBSERVATIONS} reached.`);
    const sequence = this.observations.length + 1;
    const request_id = `read-${sequence.toString().padStart(3, "0")}`;
    const result = await this.reader.execute(this.runtimeId, request_id, command);
    this.observations.push({ sequence, request_id, command, result });
    return { request_id, result };
  }

  buildEvidence(): SemanticChallengeEvidence {
    if (this.observations.length === 0) throw new Error("semantic challenge cannot build evidence before an exact repository observation.");
    return buildSemanticChallengeEvidence({ request: this.request, observations: this.observations });
  }
}
