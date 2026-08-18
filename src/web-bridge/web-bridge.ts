import type { JobMode } from "../orchestration/job-mode.js";
import type { AuthoringEvent, BridgeConnectionStatus, BridgeJobIdentity, FinalReviewRequest, RepositoryBinding, RepositoryCommandResult, WebContractEnvelope, WebImplementationSubmission, WebVerdictEnvelope } from "./contracts.js";

export interface AuthoringJobRequest { owner: string; repository: RepositoryBinding; user_intent: string; ttl_seconds: number; orchestration_mode?: JobMode; }
export interface WebBridge {
  createAuthoringJob(request: AuthoringJobRequest, idempotencyKey: string): Promise<BridgeJobIdentity>;
  waitForAuthoringEvent(jobId: string, afterSequence: number, signal?: AbortSignal): Promise<AuthoringEvent | null>;
  submitRepositoryCommandResult(jobId: string, result: RepositoryCommandResult, idempotencyKey: string): Promise<void>;
  submitClarification(jobId: string, text: string, idempotencyKey: string): Promise<void>;
  receiveSealedContract(jobId: string): Promise<WebContractEnvelope | null>;
  receiveWebImplementation(jobId: string): Promise<WebImplementationSubmission | null>;
  /** Optional provider-specific preflight. It must not create durable authority. */
  preflightFinalReviewEvidence?(evidence: Record<string, unknown>): Promise<void>;
  createFinalReviewJob(request: FinalReviewRequest, idempotencyKey: string): Promise<BridgeJobIdentity>;
  submitFinalReviewEvidence(reviewId: string, evidence: Record<string, unknown>, idempotencyKey: string): Promise<void>;
  waitForVerdict(reviewId: string, signal?: AbortSignal): Promise<WebVerdictEnvelope | null>;
  getConnectionStatus(): Promise<BridgeConnectionStatus>;
}
