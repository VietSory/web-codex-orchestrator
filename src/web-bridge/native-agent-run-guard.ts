import { WebBridgeError } from "./contracts.js";
import type { NativeOpenAiCredential } from "./native-openai-credential.js";

/**
 * Local completion guard for an accepted Workspace Agent trigger.
 *
 * OpenAI's current trigger API returns 202 without a provider run id and does
 * not expose an API for retrieving the run result. WCO therefore never polls
 * invented provider state. Completion authority comes only from an exact
 * semantic envelope arriving through the local WCO MCP mailbox. This guard
 * merely bounds how long the local orchestrator will wait for that evidence.
 */
export class NativeAgentRunGuard {
  private readonly startedAt: number;

  constructor(
    _credential: NativeOpenAiCredential,
    readonly run_id: string,
    _fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly timeoutMs = 15 * 60 * 1_000,
  ) {
    if (!/^accepted_[a-f0-9]{48}$/.test(run_id)) {
      throw new WebBridgeError("WEB_NATIVE_TRIGGER_INVALID", "Local Workspace Agent trigger receipt id is invalid.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 86_400_000) {
      throw new WebBridgeError("WEB_NATIVE_TRIGGER_INVALID", "Workspace Agent evidence timeout is invalid.");
    }
    this.startedAt = this.now();
  }

  async status(): Promise<"running" | "completed"> {
    if (this.now() - this.startedAt >= this.timeoutMs) {
      throw new WebBridgeError(
        "WEB_NATIVE_AGENT_TIMEOUT",
        "The accepted ChatGPT Workspace Agent turn did not submit the required semantic envelope to the local WCO MCP mailbox before the bounded wait expired. WCO did not retry through a third-party relay and no repository authority was advanced.",
      );
    }
    return "running";
  }

  async assertCanStillComplete(): Promise<"running" | "completed"> {
    return await this.status();
  }
}
