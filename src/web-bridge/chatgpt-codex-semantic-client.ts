import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentClient, AgentTurnResponse } from "../agent/contracts.js";
import type { AgentProfile } from "../config/contracts.js";
import { CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA, CHATGPT_CODEX_CHALLENGE_OUTPUT_SCHEMA, CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA } from "./chatgpt-codex-output-schema.js";

export const CHATGPT_CODEX_AUTHOR_PHASE_MARKER = "WCO_SEMANTIC_PHASE:AUTHOR";
export const CHATGPT_CODEX_REVIEW_PHASE_MARKER = "WCO_SEMANTIC_PHASE:REVIEW";
export const CHATGPT_CODEX_CHALLENGE_PHASE_MARKER = "WCO_SEMANTIC_PHASE:CHALLENGE";
const DEFAULT_PROVIDER_TURN_SECONDS = 900;
const MAX_PROVIDER_TURN_SECONDS = 3600;
const MAX_AUDITED_PUBLIC_EVENTS = 256;
const ALLOWED_PROMPT_ONLY_EVENT_TYPES = new Set(["thread.started", "turn.started", "reasoning", "todo_list", "agent_message", "turn.completed"]);
type MeasuredProviderUsage = { input_tokens: number; cached_input_tokens: number; output_tokens: number };

function schemaForPrompt(prompt: string): Record<string, unknown> {
  if (prompt.startsWith(`${CHATGPT_CODEX_AUTHOR_PHASE_MARKER}\n`)) return CHATGPT_CODEX_AUTHOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  if (prompt.startsWith(`${CHATGPT_CODEX_REVIEW_PHASE_MARKER}\n`)) return CHATGPT_CODEX_REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  if (prompt.startsWith(`${CHATGPT_CODEX_CHALLENGE_PHASE_MARKER}\n`)) return CHATGPT_CODEX_CHALLENGE_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  throw new Error("WEB_CHATGPT_CODEX_PHASE_INVALID: semantic prompt is missing a closed WCO phase marker.");
}

function timeoutError(): Error & { code: string } {
  return Object.assign(new Error("Local ChatGPT/Codex semantic provider turn exceeded its bounded deadline."), { code: "WEB_CHATGPT_CODEX_TURN_TIMEOUT" });
}

function semanticAuditError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function assertPromptOnlyProviderEvents(events: AgentTurnResponse["public_events"]): void {
  if (!events || events.length === 0) throw semanticAuditError("WEB_CHATGPT_CODEX_EVENT_AUDIT_UNAVAILABLE", "Semantic provider did not return its public event audit trail.");
  if (events.length >= MAX_AUDITED_PUBLIC_EVENTS) throw semanticAuditError("WEB_CHATGPT_CODEX_EVENT_AUDIT_TRUNCATED", "Semantic provider event audit trail reached its truncation bound; later tool activity cannot be excluded.");
  let turnStarted = 0;
  let turnCompleted = 0;
  let agentMessages = 0;
  let threadStarted = 0;
  for (const event of events) {
    if (!ALLOWED_PROMPT_ONLY_EVENT_TYPES.has(event.type)) throw semanticAuditError("WEB_CHATGPT_CODEX_TOOL_ACTIVITY_FORBIDDEN", `Semantic provider observed forbidden local/external tool activity '${event.type}'.`);
    if (event.type === "thread.started") threadStarted += 1;
    else if (event.type === "turn.started") turnStarted += 1;
    else if (event.type === "turn.completed") turnCompleted += 1;
    else if (event.type === "agent_message") agentMessages += 1;
  }
  if (threadStarted > 1 || turnStarted !== 1 || turnCompleted !== 1 || agentMessages < 1) throw semanticAuditError("WEB_CHATGPT_CODEX_EVENT_AUDIT_INVALID", "Semantic provider event lifecycle is incomplete or ambiguous.");
}

function measuredUsage(usage: AgentTurnResponse["usage"]): MeasuredProviderUsage {
  const input = usage?.input_tokens, cached = usage?.cached_input_tokens, output = usage?.output_tokens;
  if (![input, cached, output].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw Object.assign(new Error("Local ChatGPT/Codex semantic provider did not return valid token usage."), { code: "WEB_CHATGPT_CODEX_USAGE_UNAVAILABLE" });
  return { input_tokens: input as number, cached_input_tokens: cached as number, output_tokens: output as number };
}

async function assertEmptyBlindDirectory(target: string, label: string): Promise<string> {
  const absolute = path.resolve(target);
  const info = await lstat(absolute).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`WEB_CHATGPT_CODEX_CHALLENGE_FILESYSTEM_INVALID: ${label} directory is unsafe.`);
  const directory = await opendir(absolute);
  try {
    if (await directory.read()) throw new Error(`WEB_CHATGPT_CODEX_CHALLENGE_FILESYSTEM_INVALID: ${label} directory must remain empty.`);
  } finally {
    await directory.close().catch(() => undefined);
  }
  return absolute;
}

async function assertBlindChallengeFilesystem(scratchDirectory: string, authorityDirectory: string): Promise<void> {
  const scratch = path.resolve(scratchDirectory);
  const authority = path.resolve(authorityDirectory);
  if (scratch === authority || scratch.startsWith(`${authority}${path.sep}`) || authority.startsWith(`${scratch}${path.sep}`)) {
    throw new Error("WEB_CHATGPT_CODEX_CHALLENGE_FILESYSTEM_INVALID: challenge filesystem roots must be independent.");
  }
  await assertEmptyBlindDirectory(scratch, "challenge scratch");
  await assertEmptyBlindDirectory(authority, "challenge authority");
}

/** Read-only/no-network semantic provider adapter with closed phase schema,
 * trusted per-turn deadline, mandatory measurable token usage, prompt-only SDK
 * event attestation, and a challenge-specific empty-filesystem boundary before
 * a blind Web-B turn reaches Codex. */
export class ChatGptCodexSemanticClient {
  constructor(private readonly agent: AgentClient, private readonly maximumTurnSeconds = DEFAULT_PROVIDER_TURN_SECONDS) {
    if (!Number.isFinite(maximumTurnSeconds) || maximumTurnSeconds <= 0 || maximumTurnSeconds > MAX_PROVIDER_TURN_SECONDS) throw new Error("WEB_CHATGPT_CODEX_CONFIG_INVALID: semantic turn timeout is outside the trusted 1-3600 second range.");
  }

  async checkAvailability(): Promise<void> { await this.agent.checkAvailability(); }

  async turn(options: { profile: AgentProfile; prompt: string; scratchDirectory: string; authorityDirectory: string; threadId?: string; signal?: AbortSignal }): Promise<{ thread_id: string; output: unknown; usage: MeasuredProviderUsage }> {
    const outputSchema = schemaForPrompt(options.prompt);
    if (options.prompt.startsWith(`${CHATGPT_CODEX_CHALLENGE_PHASE_MARKER}\n`)) {
      await assertBlindChallengeFilesystem(options.scratchDirectory, options.authorityDirectory);
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(this.maximumTurnSeconds * 1_000)));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const result = await this.agent.turn({ role: "final_reviewer", model: options.profile.model, reasoning_effort: options.profile.reasoning_effort, ...(options.threadId ? { thread_id: options.threadId } : {}), prompt: options.prompt, output_schema: outputSchema, read_only: true, approval_policy: "never", sandbox_mode: "read-only", network_access: false, live_web_search: false, cached_web_search: false, workspace_path: options.scratchDirectory, accepted_bundle_path: options.authorityDirectory, signal });
      assertPromptOnlyProviderEvents(result.public_events);
      return { thread_id: result.thread_id, output: result.output, usage: measuredUsage(result.usage) };
    } catch (error) {
      if (timeout.aborted && !options.signal?.aborted) throw timeoutError();
      throw error;
    }
  }
}
