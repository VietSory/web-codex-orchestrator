import path from "node:path";
import type { AgentClient } from "../agent/contracts.js";
import { ChatGptBrowserAgentClient } from "../agent/chatgpt-browser-client.js";
import {
  ChatGptWebCompanionAgentClient,
  isChatGptWebCompanionConfigured,
} from "../agent/chatgpt-web-companion-client.js";
import type { TrustedConfig } from "../config/contracts.js";
import { ChatGptCodexWebBridge } from "./chatgpt-codex-bridge.js";
import type { AuthoringEvent, BridgeConnectionStatus, BridgeJobIdentity, FinalReviewRequest, RepositoryCommandResult, WebContractEnvelope, WebImplementationSubmission, WebVerdictEnvelope } from "./contracts.js";
import type { PreparedRunAwareWebBridge } from "./prepared-run-aware.js";
import type { AuthoringJobRequest } from "./web-bridge.js";

function truthyEnvironmentFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Core ChatGPT Web transport for PAIR.
 *
 * The mature WCO semantic/implementation state machine stays provider-neutral.
 * Provider turns are injected through AgentClient and therefore never need a
 * Codex model. When an installed miuuyy/codex-chatgpt-web 3.0.3 launcher is
 * discoverable, WCO talks to its launcher-owned browser helper over bounded
 * stdin/stdout. That keeps the browser/CDP boundary Windows-native while WCO,
 * Bubblewrap verification, Git and publication authority remain in WSL/Linux.
 *
 * The legacy direct local Chromium adapter remains available only when no
 * qualified miuuyy launcher is configured, for non-WSL qualification and
 * backwards compatibility. Neither path may silently fall back to Codex.
 */
export class ChatGptBrowserWebBridge implements PreparedRunAwareWebBridge {
  private readonly delegate: ChatGptCodexWebBridge;
  private readonly agent: AgentClient;
  private readonly accountLabel: string;

  constructor(
    config: TrustedConfig,
    bridgeDirectory: string,
    stateDirectory: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    browserAgent?: AgentClient,
  ) {
    const companion = !browserAgent && isChatGptWebCompanionConfigured(env);
    this.agent = browserAgent
      ?? (companion
        ? new ChatGptWebCompanionAgentClient({ env })
        : new ChatGptBrowserAgentClient({ stateDirectory, env }));
    this.accountLabel = companion
      ? "ChatGPT Web companion"
      : "ChatGPT Web browser";
    this.delegate = new ChatGptCodexWebBridge(
      config,
      path.join(bridgeDirectory, "chatgpt-browser-provider"),
      stateDirectory,
    );

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

  async getConnectionStatus(signal?: AbortSignal): Promise<BridgeConnectionStatus> {
    // Generic CI qualification must never launch the user's browser or contact
    // chatgpt.com. Real Web dogfood is intentionally a local interactive gate.
    if (truthyEnvironmentFlag(this.env.CI)) {
      return { configured: true, connected: false, account: "CI browser probe disabled" };
    }
    try {
      await this.agent.checkAvailability(signal ? { signal } : {});
      return { configured: true, connected: true, account: this.accountLabel };
    } catch {
      return { configured: true, connected: false };
    }
  }
}
