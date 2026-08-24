import { ChatGptBrowserAgentClient } from "./chatgpt-browser-client.js";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";

/**
 * Reviewer-only browser adapter.
 *
 * ChatGptBrowserAgentClient attaches the bounded repository context pack for
 * implementation turns. The pre-publish reviewer needs the same bounded local
 * evidence but must remain semantically an internal reviewer to the rest of
 * WCO. This wrapper keeps that authority split explicit while reusing the
 * browser transport's context attachment path.
 */
export class ChatGptBrowserReviewerAgentClient implements AgentClient {
  private readonly delegate: ChatGptBrowserAgentClient;

  constructor(options: { stateDirectory: string; env?: NodeJS.ProcessEnv }) {
    this.delegate = new ChatGptBrowserAgentClient(options);
  }

  async checkAvailability(): Promise<void> {
    await this.delegate.checkAvailability();
  }

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    if (request.role !== "internal_reviewer") {
      throw Object.assign(
        new Error("ChatGPT browser reviewer accepts internal_reviewer turns only."),
        { code: "WEB_CHATGPT_BROWSER_REVIEW_ROLE_INVALID" },
      );
    }

    // The browser transport uses role=implementer only to decide whether the
    // bounded context attachment is required. The supplied prompt/output schema
    // remain the independent review contract and the Harness remains the only
    // mutation authority.
    return await this.delegate.turn({ ...request, role: "implementer" });
  }
}
