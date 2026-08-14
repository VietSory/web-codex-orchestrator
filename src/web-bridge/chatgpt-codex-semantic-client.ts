import type { AgentClient } from "../agent/contracts.js";
import type { AgentProfile } from "../config/contracts.js";
import { CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA, CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA } from "./chatgpt-codex-output-schema.js";

/**
 * Thin adapter over WCO's already-hardened Codex SDK client. It intentionally
 * requests read-only/no-approval/no-network execution and returns semantic
 * output only. Nested WCO payloads are validated by the WebBridge layer before
 * they can become repository or review authority.
 *
 * The provider-facing structured-output schema is phase-specific. Author turns
 * cannot syntactically produce review authority, and review turns cannot
 * syntactically produce repository/contract authority. This prevents a valid-
 * schema but wrong-phase response from consuming an at-most-once provider turn.
 */
export class ChatGptCodexSemanticClient {
  constructor(private readonly agent: AgentClient) {}

  async checkAvailability(): Promise<void> {
    await this.agent.checkAvailability();
  }

  async turn(options: {
    phase: "author" | "review";
    profile: AgentProfile;
    prompt: string;
    scratchDirectory: string;
    authorityDirectory: string;
    threadId?: string;
    signal?: AbortSignal;
  }): Promise<{ thread_id: string; output: unknown }> {
    const result = await this.agent.turn({
      role: "final_reviewer",
      model: options.profile.model,
      reasoning_effort: options.profile.reasoning_effort,
      ...(options.threadId ? { thread_id: options.threadId } : {}),
      prompt: options.prompt,
      output_schema: (options.phase === "author" ? CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA : CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA) as unknown as Record<string, unknown>,
      read_only: true,
      approval_policy: "never",
      sandbox_mode: "read-only",
      network_access: false,
      live_web_search: false,
      cached_web_search: false,
      workspace_path: options.scratchDirectory,
      accepted_bundle_path: options.authorityDirectory,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { thread_id: result.thread_id, output: result.output };
  }
}
