import { WcoBrowserCompanionAgentClient } from "./wco-browser-companion-client.js";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";

/**
 * Reviewer-only ChatGPT Web adapter.
 *
 * Browser PAIR authoring and review use the same first-party WCO Windows
 * companion transport, while each review request starts without a provider
 * thread id so the native transport opens a fresh ChatGPT Temporary Chat.
 *
 * The companion itself receives only prepared prompt text. This wrapper maps
 * the reviewer request to role=implementer only on the WSL side so WCO can add
 * its bounded repository context before serialization; no workspace/bundle path
 * crosses into Windows.
 */
export class ChatGptBrowserReviewerAgentClient implements AgentClient {
  private readonly delegate: AgentClient;

  constructor(options: { stateDirectory: string; env?: NodeJS.ProcessEnv }) {
    void options.stateDirectory;
    this.delegate = new WcoBrowserCompanionAgentClient({ env: options.env ?? process.env });
  }

  async checkAvailability(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.delegate.checkAvailability(options);
  }

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    if (request.role !== "internal_reviewer") {
      throw Object.assign(
        new Error("ChatGPT browser reviewer accepts internal_reviewer turns only."),
        { code: "WEB_CHATGPT_BROWSER_REVIEW_ROLE_INVALID" },
      );
    }
    return await this.delegate.turn({ ...request, role: "implementer", thread_id: undefined });
  }
}
