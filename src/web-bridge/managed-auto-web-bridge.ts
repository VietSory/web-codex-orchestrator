import { contentDigest, WebBridgeError, type AuthoringEvent, type BridgeConnectionStatus, type BridgeJobIdentity, type FinalReviewRequest, type RepositoryCommandResult, type WebContractEnvelope, type WebImplementationSubmission, type WebVerdictEnvelope } from "./contracts.js";
import { ActionRelayWebBridge } from "./action-relay-client.js";
import { ManagedWebOnboardingClient, type ManagedAgentPurpose, type ManagedAgentTriggerReceipt } from "./managed-onboarding.js";
import type { AuthoringJobRequest, WebBridge } from "./web-bridge.js";

const AUTHOR_INPUT = "Continue the exact pending WCO authoring task. Inspect only bounded repository context exposed by WCO, seal the task contract, and submit bounded implementation authority. Never mutate repository state directly; WCO Harness alone applies and verifies changes.";
const REVIEW_INPUT: Record<Exclude<ManagedAgentPurpose, "author">, string> = {
  independent_code_review: "Perform the exact pending independent WCO code review. Inspect the complete changed-path inventory, every changed hunk, verifier evidence, and bounded surrounding context as needed. Submit APPROVE, REVISE with bounded repair authority, or BLOCK. Never mutate, publish, or merge.",
  final_intent_review: "Resume the original WCO author intent for the exact pending final review. Compare the exact current Draft PR result and verifier evidence to the sealed original intent, then submit APPROVE, REVISE with bounded repair authority, or BLOCK. Never mutate, publish, or merge.",
};

/**
 * Optional managed Web bridge.
 *
 * Relay transport and semantic-agent execution are deliberately separate. The
 * local client owns no Workspace Agent/OpenAI operator credential: it holds only
 * the scoped device credential obtained by one-link onboarding. The managed
 * service owns the preconfigured Agent/App credentials and maps final-intent
 * runs back to the original author conversation. Harness remains the only local
 * mutation authority.
 */
export class ManagedAutoWebBridge implements WebBridge {
  private readonly runs = new Map<string, ManagedAgentTriggerReceipt>();

  constructor(
    private readonly relay: ActionRelayWebBridge,
    private readonly managed: ManagedWebOnboardingClient,
  ) {}

  private async trigger(purpose: ManagedAgentPurpose, identity: string, input: string): Promise<void> {
    const receipt = await this.managed.triggerAgent({
      purpose,
      identity,
      input,
      idempotencyKey: `agent-${contentDigest({ purpose, identity }).slice(0, 48)}`,
    });
    this.runs.set(identity, receipt);
  }

  private async ensureAuthorRun(jobId: string): Promise<void> {
    if (this.runs.has(jobId)) return;
    // The local map is disposable. After restart, replay exactly the same
    // managed idempotency key so the service adopts the original semantic run
    // instead of requiring a browser/manual fallback or creating new authority.
    await this.trigger("author", jobId, AUTHOR_INPUT);
  }

  private async assertCanStillComplete(identity: string, expected: "implementation" | "verdict"): Promise<void> {
    const tracked = this.runs.get(identity);
    if (!tracked) throw new WebBridgeError("WEB_MANAGED_AGENT_NOT_TRIGGERED", `Managed service did not register the required ${expected} semantic turn.`);
    const run = await this.managed.readAgentRun(tracked.agent_trigger_run_id);
    if (run.status === "queued" || run.status === "in_progress") return;
    if (run.status === "suspended") {
      throw new WebBridgeError("WEB_MANAGED_OPERATOR_CONFIGURATION_REQUIRED", "The maintainer-operated WCO Agent was suspended for interaction. This is an operator configuration defect; the end user must not be asked to open ChatGPT, approve tools, or configure credentials per task.");
    }
    if (run.status === "failed") {
      throw new WebBridgeError("WEB_MANAGED_AGENT_FAILED", `The maintainer-operated WCO Agent failed${run.error?.code ? ` (${run.error.code})` : ""}${run.error?.message ? `: ${run.error.message}` : "."}`);
    }
    throw new WebBridgeError("WEB_MANAGED_AGENT_INCOMPLETE", `The managed semantic turn completed without submitting the required WCO ${expected}. No browser/manual fallback was attempted.`);
  }

  async createAuthoringJob(request: AuthoringJobRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    const identity = await this.relay.createAuthoringJob(request, idempotencyKey);
    await this.ensureAuthorRun(identity.job_id);
    return identity;
  }

  async waitForAuthoringEvent(jobId: string, afterSequence: number, signal?: AbortSignal): Promise<AuthoringEvent | null> {
    if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted.");
    await this.ensureAuthorRun(jobId);
    const event = await this.relay.waitForAuthoringEvent(jobId, afterSequence);
    if (!event) await this.assertCanStillComplete(jobId, "implementation");
    return event;
  }

  async submitRepositoryCommandResult(jobId: string, result: RepositoryCommandResult, idempotencyKey: string): Promise<void> {
    await this.relay.submitRepositoryCommandResult(jobId, result, idempotencyKey);
  }

  async submitClarification(jobId: string, text: string, idempotencyKey: string): Promise<void> {
    await this.relay.submitClarification(jobId, text, idempotencyKey);
  }

  async receiveSealedContract(jobId: string): Promise<WebContractEnvelope | null> { return await this.relay.receiveSealedContract(jobId); }
  async receiveWebImplementation(jobId: string): Promise<WebImplementationSubmission | null> { return await this.relay.receiveWebImplementation(jobId); }

  async createFinalReviewJob(request: FinalReviewRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    return await this.relay.createFinalReviewJob(request, idempotencyKey);
  }

  async submitFinalReviewEvidence(reviewId: string, evidence: Record<string, unknown>, idempotencyKey: string): Promise<void> {
    await this.relay.submitFinalReviewEvidence(reviewId, evidence, idempotencyKey);
    const purpose = evidence.purpose;
    if (purpose !== "independent_code_review" && purpose !== "final_intent_review") throw new WebBridgeError("WEB_MANAGED_REVIEW_PURPOSE_INVALID", "Managed review evidence must declare an exact review purpose before automatic triggering.");
    await this.trigger(purpose, reviewId, REVIEW_INPUT[purpose]);
  }

  async waitForVerdict(reviewId: string, signal?: AbortSignal): Promise<WebVerdictEnvelope | null> {
    if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted.");
    const verdict = await this.relay.waitForVerdict(reviewId);
    if (!verdict) await this.assertCanStillComplete(reviewId, "verdict");
    return verdict;
  }

  async getConnectionStatus(): Promise<BridgeConnectionStatus> { return await this.relay.getConnectionStatus(); }
}
