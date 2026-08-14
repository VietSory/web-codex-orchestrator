import type { AgentClient, AgentTurnResponse } from "../agent/contracts.js";
import type { AgentProfile } from "../config/contracts.js";
import { CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA, CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA } from "./chatgpt-codex-output-schema.js";

export const CHATGPT_CODEX_AUTHOR_PHASE_MARKER = "WCO_SEMANTIC_PHASE:AUTHOR";
export const CHATGPT_CODEX_REVIEW_PHASE_MARKER = "WCO_SEMANTIC_PHASE:REVIEW";
const DEFAULT_PROVIDER_TURN_SECONDS = 900;
const MAX_PROVIDER_TURN_SECONDS = 3600;

function schemaForPrompt(prompt: string): Record<string, unknown> {
  if (prompt.startsWith(`${CHATGPT_CODEX_AUTHOR_PHASE_MARKER}\n`)) return CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  if (prompt.startsWith(`${CHATGPT_CODEX_REVIEW_PHASE_MARKER}\n`)) return CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  throw new Error("WEB_CHATGPT_CODEX_PHASE_INVALID: semantic prompt is missing a closed WCO phase marker.");
}

function timeoutError(): Error & { code: string } {
  return Object.assign(new Error("Local ChatGPT/Codex semantic provider turn exceeded its bounded deadline."), { code: "WEB_CHATGPT_CODEX_TURN_TIMEOUT" });
}

function measuredUsage(usage: AgentTurnResponse["usage"]): NonNullable<AgentTurnResponse["usage"]> {
  if (!usage || ![usage.input_tokens, usage.cached_input_tokens, usage.output_tokens].every((value) => Number.isSafeInteger(value) && value >= 0)) throw Object.assign(new Error("Local ChatGPT/Codex semantic provider did not return valid token usage."), { code: "WEB_CHATGPT_CODEX_USAGE_UNAVAILABLE" });
  return usage;
}

/** Read-only/no-network semantic provider adapter with closed phase schema,
 * trusted per-turn deadline, and mandatory measurable token usage. */
export class ChatGptCodexSemanticClient {
  constructor(private readonly agent: AgentClient, private readonly maximumTurnSeconds = DEFAULT_PROVIDER_TURN_SECONDS) {
    if (!Number.isFinite(maximumTurnSeconds) || maximumTurnSeconds <= 0 || maximumTurnSeconds > MAX_PROVIDER_TURN_SECONDS) throw new Error("WEB_CHATGPT_CODEX_CONFIG_INVALID: semantic turn timeout is outside the trusted 1-3600 second range.");
  }

  async checkAvailability(): Promise<void> { await this.agent.checkAvailability(); }

  async turn(options: {
    profile: AgentProfile;
    prompt: string;
    scratchDirectory: string;
    authorityDirectory: string;
    threadId?: string;
    signal?: AbortSignal;
  }): Promise<{ thread_id: string; output: unknown; usage: NonNullable<AgentTurnResponse["usage"]> }> {
    const outputSchema = schemaForPrompt(options.prompt);
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(this.maximumTurnSeconds * 1_000)));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
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
        signal,
      });
      return { thread_id: result.thread_id, output: result.output, usage: measuredUsage(result.usage) };
    } catch (error) {
      if (timeout.aborted && !options.signal?.aborted) throw timeoutError();
      throw error;
    }
  }
}
