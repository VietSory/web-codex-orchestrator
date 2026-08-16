import type { BridgeJobIdentity, RepositoryCommand, RepositoryCommandResult } from "../web-bridge/contracts.js";
import type { WebBridge } from "../web-bridge/web-bridge.js";
import type { SemanticChallengeRequest, SemanticUnderstandingEnvelope } from "./blind-challenge.js";

/**
 * Optional, non-authoritative transport capability for an independent Web-B
 * semantic challenge. This is deliberately NOT part of WebBridge: authoring,
 * execution and final-review adapters must continue to work without semantic
 * challenge support, and the challenge transport must never become execution
 * authority by interface inheritance alone.
 */
export interface SemanticChallengeAwareWebBridge extends WebBridge {
  createSemanticChallengeJob(request: SemanticChallengeRequest, idempotencyKey: string): Promise<BridgeJobIdentity>;
  waitForSemanticChallengeAction(jobId: string, afterSequence: number, signal?: AbortSignal): Promise<SemanticChallengeRemoteAction | null>;
  submitSemanticChallengeRepositoryResult(jobId: string, result: RepositoryCommandResult, idempotencyKey: string): Promise<void>;
  receiveSemanticUnderstanding(jobId: string): Promise<SemanticUnderstandingEnvelope | null>;
}

export type SemanticChallengeRemoteAction =
  | { sequence: number; type: "repository_command"; request_id: string; command: RepositoryCommand }
  | { sequence: number; type: "semantic_understanding_sealed"; envelope: SemanticUnderstandingEnvelope };

export function isSemanticChallengeAwareWebBridge(value: WebBridge): value is SemanticChallengeAwareWebBridge {
  const candidate = value as Partial<SemanticChallengeAwareWebBridge>;
  return typeof candidate.createSemanticChallengeJob === "function"
    && typeof candidate.waitForSemanticChallengeAction === "function"
    && typeof candidate.submitSemanticChallengeRepositoryResult === "function"
    && typeof candidate.receiveSemanticUnderstanding === "function";
}
