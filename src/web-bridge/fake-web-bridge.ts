import { contentDigest, WEB_BRIDGE_PROTOCOL_VERSION, type AuthoringEvent, type BridgeConnectionStatus, type BridgeJobIdentity, type WebContractEnvelope, type WebImplementationSubmission, type WebVerdictEnvelope } from "./contracts.js";
import type { AuthoringJobRequest, WebBridge } from "./web-bridge.js";
import type { FinalReviewRequest, RepositoryCommandResult } from "./contracts.js";

export class FakeWebBridge implements WebBridge {
  readonly repositoryResults: RepositoryCommandResult[] = [];
  readonly finalReviewEvidence = new Map<string, Record<string, unknown>>();
  readonly clarifications: string[] = [];
  readonly authoringRequests: AuthoringJobRequest[] = [];
  private readonly authoring = new Map<string, BridgeJobIdentity>();
  private readonly review = new Map<string, BridgeJobIdentity>();
  private readonly events = new Map<string, AuthoringEvent[]>();
  private readonly contracts = new Map<string, WebContractEnvelope>();
  private readonly implementations = new Map<string, WebImplementationSubmission>();
  private readonly verdicts = new Map<string, WebVerdictEnvelope>();
  constructor(private readonly clock: () => Date = () => new Date("2026-01-01T00:00:00.000Z")) {}
  async createAuthoringJob(request: AuthoringJobRequest, idempotencyKey: string): Promise<BridgeJobIdentity> { this.authoringRequests.push({ ...request, repository: { ...request.repository } }); return this.create(this.authoring, "job", request, idempotencyKey, request.owner, request.ttl_seconds); }
  async createFinalReviewJob(request: FinalReviewRequest, idempotencyKey: string): Promise<BridgeJobIdentity> { return this.create(this.review, "review", request, idempotencyKey, "local", 86_400); }
  async submitFinalReviewEvidence(reviewId: string, evidence: Record<string, unknown>): Promise<void> { this.finalReviewEvidence.set(reviewId, evidence); }
  private create(store: Map<string, BridgeJobIdentity>, prefix: string, request: unknown, key: string, owner: string, ttl: number): BridgeJobIdentity { const id = `${prefix}-${contentDigest({ request, key }).slice(0, 24)}`; const existing = store.get(id); if (existing) return existing; const created = this.clock(); const value = { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: id, owner, created_at: created.toISOString(), expires_at: new Date(created.getTime() + ttl * 1000).toISOString(), content_sha256: contentDigest(request) } as const; store.set(id, value); return value; }
  async waitForAuthoringEvent(jobId: string, afterSequence: number): Promise<AuthoringEvent | null> { return this.events.get(jobId)?.find((event) => event.sequence > afterSequence) ?? null; }
  async submitRepositoryCommandResult(_jobId: string, result: RepositoryCommandResult): Promise<void> { this.repositoryResults.push(result); }
  async submitClarification(_jobId: string, value: string): Promise<void> { this.clarifications.push(value); }
  async receiveSealedContract(jobId: string): Promise<WebContractEnvelope | null> { return this.contracts.get(jobId) ?? null; }
  async receiveWebImplementation(jobId: string): Promise<WebImplementationSubmission | null> { return this.implementations.get(jobId) ?? null; }
  async waitForVerdict(reviewId: string): Promise<WebVerdictEnvelope | null> { return this.verdicts.get(reviewId) ?? null; }
  async getConnectionStatus(): Promise<BridgeConnectionStatus> { return { configured: true, connected: true, ...(this.authoring.size ? { pending_author_job: [...this.authoring.keys()][0] } : {}), ...(this.review.size ? { pending_final_review: [...this.review.keys()][0] } : {}) }; }
  enqueue(jobId: string, event: AuthoringEvent): void { const values = this.events.get(jobId) ?? []; values.push(event); values.sort((a, b) => a.sequence - b.sequence); this.events.set(jobId, values); if (event.type === "contract_sealed") this.contracts.set(jobId, event.envelope); if (event.type === "implementation_sealed") this.implementations.set(jobId, event.submission); }
  submitVerdict(reviewId: string, verdict: WebVerdictEnvelope): void { this.verdicts.set(reviewId, verdict); }
}
