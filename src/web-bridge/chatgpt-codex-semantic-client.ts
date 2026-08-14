import type { AgentClient } from "../agent/contracts.js";
import type { AgentProfile } from "../config/contracts.js";
import { CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA, CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA } from "./chatgpt-codex-output-schema.js";

export const CHATGPT_CODEX_AUTHOR_PHASE_MARKER = "WCO_SEMANTIC_PHASE:AUTHOR";
export const CHATGPT_CODEX_REVIEW_PHASE_MARKER = "WCO_SEMANTIC_PHASE:REVIEW";

function schemaForPrompt(prompt: string): Record<string, unknown> {
  if (prompt.startsWith(`${CHATGPT_CODEX_AUTHOR_PHASE_MARKER}\n`)) return CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  if (prompt.startsWith(`${CHATGPT_CODEX_REVIEW_PHASE_MARKER}\n`)) return CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  throw new Error("WEB_CHATGPT_CODEX_PHASE_INVALID: semantic prompt is missing a closed WCO phase marker.");
}

/**
 * Thin adapter over WCO's already-hardened Codex SDK client. It intentionally
 * requests read-only/no-approval/no-network execution and returns semantic
 * output only. Nested WCO payloads are validated by the WebBridge layer before
 * they can become repository or review authority.
 *
 * The first prompt line is an internal closed phase marker emitted only by WCO's
 * prompt builders. It selects a phase-specific provider schema: author turns
 * cannot syntactically produce review authority, and review turns cannot
 * syntactically produce repository/contract authority. Unknown prompts fail
 * before the provider boundary instead of consuming an at-most-once turn.
 */
export class ChatGptCodexSemanticClient {
  constructor(private readonly agent: AgentClient) {}

  async checkAvailability(): Promise<void> {
    await this.agent.checkAvailability();
  }

  async turn(options: {
    profile: AgentProfile;
    prompt: string;
    scratchDirectory: string;
    authorityDirectory: string;
    threadId?: string;
    signal?: AbortSignal;
  }): Promise<{ thread_id: string; output: unknown }> {
    const outputSchema = schemaForPrompt(options.prompt);
    const result = await this.agent.turn({
      role: "final_reviewer",
      model: options.profile.model,
      reasoning_effort: options.profile.reasoning_effort,
      ...(options.threadId ? { thread_id: options.threadId } : {}),
      prompt: options.prompt,
      output_schema: outputSchema,
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
