import path from "node:path";
import { ChatGptBrowserAgentClient } from "../agent/chatgpt-browser-client.js";
import type { AgentClient } from "../agent/contracts.js";
import type { TrustedConfig } from "../config/contracts.js";
import { ChatGptCodexWebBridge } from "./chatgpt-codex-bridge.js";
import type { AuthoringEvent, BridgeConnectionStatus, BridgeJobIdentity, FinalReviewRequest, RepositoryCommandResult, WebContractEnvelope, WebImplementationSubmission, WebVerdictEnvelope } from "./contracts.js";
import type { PreparedRunAwareWebBridge } from "./prepared-run-aware.js";
import type { AuthoringJobRequest } from "./web-bridge.js";

/**
 * Core, opt-in ChatGPT Web transport for the user's own interactive browser
 * session. It deliberately reuses WCO's mature semantic/implementation/review
 * state machine while replacing only the provider turn boundary.
 *
 * No cookies, bearer tokens, private ChatGPT endpoints, CAPTCHA bypasses, or
 * anti-bot workarounds are read or implemented here. Browser state lives in a
 * dedicated persistent Chromium profile owned by the local user. If ChatGPT
 * presents a protective verification step, the provider fails closed.
 */
export class ChatGptBrowserWebBridge implements PreparedRunAwareWebBridge {
  private readonly delegate: ChatGptCodexWebBridge;
  private readonly agent: ChatGptBrowserAgentClient;

  constructor(config: TrustedConfig, bridgeDirectory: string, stateDirectory: string, env: NodeJS.ProcessEnv = process.env) {
    this.agent = new ChatGptBrowserAgentClient({ stateDirectory, env });
    this.delegate = new ChatGptCodexWebBridge(config, path.join(bridgeDirectory, "chatgpt-browser-provider"), stateDirectory);

    // ChatGptCodexWebBridge predates provider injection and currently keeps the
    // two provider hooks as TypeScript-private (not ECMAScript #private)
    // methods. Shadow those hooks on this isolated delegate instance so the
    // rest of its durable protocol remains unchanged. This is intentionally
    // kept in one adapter and covered by a runtime shape guard; a later cleanup
    // can promote the hooks to an explicit provider interface without changing
    // browser behavior.
    const providerHooks = this.delegate as unknown as Record<string, unknown>;
    if (typeof providerHooks.rawAgent !== "function" || typeof providerHooks.ensureAuthorizedForProviderTurn !== "function") {
      throw new Error("WEB_CHATGPT_BROWSER_PROVIDER_HOOK_MISMATCH: local semantic bridge provider hooks changed.");
    }
    Object.defineProperty(this.delegate, "rawAgent", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: async (): Promise<AgentClient> => this.agent,
    });
    Object.defineProperty(this.delegate, "ensureAuthorizedForProviderTurn", {
      configurable: false,
      enumerable: false,
      writable: false,
      // BrowserAgentClient.turn performs its own login/protective-measure
      // preflight on the exact target tab. Avoid opening a second throwaway tab
      // before every provider turn.
      value: async (): Promise<void> => undefined,
    });
  }

  async createAuthoringJob(request: AuthoringJobRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    return await this.delegate.createAuthoringJob(request, idempotencyKey);
  }

  async waitForAuthoringEvent(jobId: string, afterSequence: number, signal?: AbortSignal): Promise<AuthoringEvent | null> {
    return await this.delegate.waitForAuthoringEvent(jobId, afterSequence, signal);
  }

  async submitRepositoryCommandResult(jobId: string, result: RepositoryCommandResult, idempotencyKey: string): Promise<void> {
    await this.delegate.submitRepositoryCommandResult(jobId, result, idempotencyKey);
  }

  async submitClarification(jobId: string, text: string, idempotencyKey: string): Promise<void> {
    await this.delegate.submitClarification(jobId, text, idempotencyKey);
  }

  async receiveSealedContract(jobId: string): Promise<WebContractEnvelope | null> {
    return await this.delegate.receiveSealedContract(jobId);
  }

  async bindPreparedRun(jobId: string, runId: string, idempotencyKey: string): Promise<void> {
    await this.delegate.bindPreparedRun(jobId, runId, idempotencyKey);
  }

  async receiveWebImplementation(jobId: string): Promise<WebImplementationSubmission | null> {
    return await this.delegate.receiveWebImplementation(jobId);
  }

  async preflightFinalReviewEvidence(evidence: Record<string, unknown>): Promise<void> {
    await this.delegate.preflightFinalReviewEvidence(evidence);
  }

  async createFinalReviewJob(request: FinalReviewRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    return await this.delegate.createFinalReviewJob(request, idempotencyKey);
  }

  async submitFinalReviewEvidence(reviewId: string, evidence: Record<string, unknown>, idempotencyKey: string): Promise<void> {
    await this.delegate.submitFinalReviewEvidence(reviewId, evidence, idempotencyKey);
  }

  async waitForVerdict(reviewId: string, signal?: AbortSignal): Promise<WebVerdictEnvelope | null> {
    return await this.delegate.waitForVerdict(reviewId, signal);
  }

  async getConnectionStatus(): Promise<BridgeConnectionStatus> {
    try {
      await this.agent.checkAvailability();
      return { configured: true, connected: true, account: "ChatGPT Web browser" };
    } catch {
      return { configured: true, connected: false };
    }
  }
}
