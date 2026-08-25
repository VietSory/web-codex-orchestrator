import { ChatGptBrowserAgentClient } from "./chatgpt-browser-client.js";
import {
  ChatGptWebCompanionAgentClient,
  isChatGptWebCompanionConfigured,
} from "./chatgpt-web-companion-client.js";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";

/**
 * Reviewer-only ChatGPT Web adapter.
 *
 * The reviewer must use the same provider family as browser PAIR while keeping
 * a fresh logical conversation. If the installed miuuyy launcher helper is
 * available, reviewer turns use that Windows-native stdio boundary too;
 * otherwise the legacy direct Chromium transport remains available for local
 * non-WSL qualification.
 *
 * The underlying browser transports attach bounded repository context only for
 * implementer-shaped turns. This wrapper therefore maps the reviewer request to
 * role=implementer strictly at the transport boundary; the prompt/schema remain
 * the independent reviewer contract and WCO retains all mutation authority.
 */
export class ChatGptBrowserReviewerAgentClient implements AgentClient {
  private readonly delegate: AgentClient;

  constructor(options: { stateDirectory: string; env?: NodeJS.ProcessEnv }) {
    const env = options.env ?? process.env;
    this.delegate = isChatGptWebCompanionConfigured(env)
      ? new ChatGptWebCompanionAgentClient({ env })
      : new ChatGptBrowserAgentClient({ stateDirectory: options.stateDirectory, env });
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

    return await this.delegate.turn({ ...request, role: "implementer" });
  }
}
