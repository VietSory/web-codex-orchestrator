import type { AuthoringEvent, BridgeConnectionStatus, BridgeJobIdentity, FinalReviewRequest, RepositoryCommandResult, WebContractEnvelope, WebImplementationSubmission, WebVerdictEnvelope } from "./contracts.js";
import { parseWebContractEnvelope, parseWebImplementationSubmission, parseWebVerdictEnvelope } from "./contracts.js";
import type { AuthoringJobRequest, WebBridge } from "./web-bridge.js";
import { RelayFileStore } from "./relay/file-store.js";
import { toAuthoringEvent } from "./relay/protocol.js";

export class ManualFileWebBridge implements WebBridge {
  constructor(private readonly store: RelayFileStore, private readonly owner = "local") {}
  async createAuthoringJob(request: AuthoringJobRequest, idempotencyKey: string): Promise<BridgeJobIdentity> { return await this.store.create("authoring", this.owner, request, idempotencyKey, request.ttl_seconds); }
  async waitForAuthoringEvent(jobId: string, afterSequence: number): Promise<AuthoringEvent | null> { for (const event of await this.store.events(jobId, this.owner, afterSequence)) { const value = toAuthoringEvent(event); if (value) return value; } return null; }
  async submitRepositoryCommandResult(jobId: string, result: RepositoryCommandResult, idempotencyKey: string): Promise<void> { await this.store.append(jobId, this.owner, "repository_command_result", result, idempotencyKey); }
  async submitClarification(jobId: string, text: string, idempotencyKey: string): Promise<void> { await this.store.append(jobId, this.owner, "user_clarification", { text }, idempotencyKey); }
  async receiveSealedContract(jobId: string): Promise<WebContractEnvelope | null> { const event = (await this.store.events(jobId, this.owner, 0)).slice().reverse().find((value) => value.type === "contract_sealed"); return event ? parseWebContractEnvelope((event.payload as { envelope?: unknown }).envelope ?? event.payload) : null; }
  async receiveWebImplementation(jobId: string): Promise<WebImplementationSubmission | null> { const event = (await this.store.events(jobId, this.owner, 0)).slice().reverse().find((value) => value.type === "implementation_sealed"); return event ? parseWebImplementationSubmission((event.payload as { submission?: unknown }).submission ?? event.payload) : null; }
  async createFinalReviewJob(request: FinalReviewRequest, idempotencyKey: string): Promise<BridgeJobIdentity> { return await this.store.create("final_review", this.owner, request, idempotencyKey, 86_400); }
  async submitFinalReviewEvidence(reviewId: string, evidence: Record<string, unknown>, idempotencyKey: string): Promise<void> { await this.store.append(reviewId, this.owner, "final_review_evidence", evidence, idempotencyKey); }
  async waitForVerdict(reviewId: string): Promise<WebVerdictEnvelope | null> { const event = (await this.store.events(reviewId, this.owner, 0)).slice().reverse().find((value) => value.type === "web_verdict"); return event ? parseWebVerdictEnvelope((event.payload as { verdict?: unknown }).verdict ?? event.payload) : null; }
  async getConnectionStatus(): Promise<BridgeConnectionStatus> { const jobs = await this.store.list(this.owner); return { configured: true, connected: true, account: this.owner, ...(jobs.find((job) => job.kind === "authoring") ? { pending_author_job: jobs.find((job) => job.kind === "authoring")!.identity.job_id } : {}), ...(jobs.find((job) => job.kind === "final_review") ? { pending_final_review: jobs.find((job) => job.kind === "final_review")!.identity.job_id } : {}) }; }
}
