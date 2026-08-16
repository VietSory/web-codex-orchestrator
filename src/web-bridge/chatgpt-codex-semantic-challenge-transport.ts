import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentLimits, AgentProfile } from "../config/contracts.js";
import { semanticChallengePrompt, createSemanticChallengeRequest, type SemanticChallengeRequest, type SemanticUnderstandingEnvelope } from "../semantic/blind-challenge.js";
import type { SemanticChallengeRemoteAction, SemanticChallengeTransport } from "../semantic/challenge-aware-web-bridge.js";
import { contentDigest, parseRepositoryCommand, WEB_BRIDGE_PROTOCOL_VERSION, type BridgeJobIdentity, type RepositoryCommandResult } from "./contracts.js";
import { CHATGPT_CODEX_PROTOCOL_VERSION } from "./chatgpt-codex-output-schema.js";
import { CHATGPT_CODEX_CHALLENGE_PHASE_MARKER, type ChatGptCodexSemanticClient } from "./chatgpt-codex-semantic-client.js";

const OWNER = "local-chatgpt-codex-semantic-challenge";
const MAX_JOB_AGE_MS = 60 * 60 * 1_000;
const MAX_PROVIDER_JOBS = 64;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Usage = { input_tokens: number; cached_input_tokens: number; output_tokens: number };
type ProviderTurnState = "idle" | "in_flight" | "ambiguous";

type ChallengeState = {
  request: SemanticChallengeRequest;
  identity: BridgeJobIdentity;
  sequence: number;
  thread_id?: string;
  awaiting_result_request_id?: string;
  pending_result?: RepositoryCommandResult;
  sealed?: SemanticUnderstandingEnvelope;
  usage: Usage & { turns: number };
  result_replays: Map<string, string>;
  turn_state: ProviderTurnState;
};

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("semantic challenge provider usage exceeded safe integer bounds.");
  return value;
}

function safeUsage(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`semantic challenge provider ${label} usage is invalid.`);
  return value;
}

function parseProviderEnvelope(value: unknown): { kind: "repository_command" | "semantic_understanding_sealed"; payload: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("semantic challenge provider envelope must be an object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.includes("protocol_version") || !keys.includes("kind") || !keys.includes("payload_json")) throw new Error("semantic challenge provider envelope fields are invalid.");
  if (record.protocol_version !== CHATGPT_CODEX_PROTOCOL_VERSION) throw new Error("semantic challenge provider protocol version is invalid.");
  if (!(record.kind === "repository_command" || record.kind === "semantic_understanding_sealed")) throw new Error("semantic challenge provider action kind is invalid.");
  if (typeof record.payload_json !== "string") throw new Error("semantic challenge provider payload_json must be a string.");
  let payload: unknown;
  try { payload = JSON.parse(record.payload_json); }
  catch { throw new Error("semantic challenge provider payload_json must contain valid JSON."); }
  return { kind: record.kind, payload };
}

function opaqueUnderstanding(value: unknown): SemanticUnderstandingEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("semantic challenge provider sealed understanding must be an object.");
  const record = value as Record<string, unknown>;
  const exact = ["schema_version", "kind", "challenge_id", "repository", "original_goal_sha256", "findings", "unresolved_questions"];
  if (Object.keys(record).length !== exact.length || exact.some((key) => !(key in record))) throw new Error("semantic challenge provider sealed understanding fields are invalid.");
  return structuredClone(value) as SemanticUnderstandingEnvelope;
}

function wirePrompt(request: SemanticChallengeRequest): string {
  return [
    CHATGPT_CODEX_CHALLENGE_PHASE_MARKER,
    semanticChallengePrompt(request),
    "Provider wire contract: return exactly one JSON wrapper with protocol_version=\"wco-chatgpt-codex-v1\", kind=\"repository_command\" or \"semantic_understanding_sealed\", and payload_json containing the exact JSON payload for that kind.",
    "For repository_command, payload_json is a RepositoryCommand only. For semantic_understanding_sealed, payload_json is the SemanticUnderstandingEnvelope only.",
    "Never include a verdict, repair operation, implementation, shell command, Git mutation, publication instruction, or Web-A candidate contract.",
  ].join("\n");
}

function followupPrompt(requestId: string, result: RepositoryCommandResult): string {
  return [
    CHATGPT_CODEX_CHALLENGE_PHASE_MARKER,
    "Continue the same independent blind semantic challenge thread.",
    `Exact repository result for remote request ${requestId}:`,
    JSON.stringify(result.result),
    "Return exactly one provider wrapper for the next repository_command or semantic_understanding_sealed action. Preserve the original challenge/repository/goal binding and cite only evidence actually returned in this thread.",
  ].join("\n");
}

async function assertEmptyCanonicalDirectory(target: string, label: string): Promise<string> {
  const absolute = path.resolve(target);
  const info = await lstat(absolute).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`semantic challenge ${label} directory is unsafe.`);
  const directory = await opendir(absolute);
  try {
    if (await directory.read()) throw new Error(`semantic challenge ${label} directory must remain empty and challenge-only.`);
  } finally {
    await directory.close().catch(() => undefined);
  }
  return absolute;
}

/**
 * Concrete local ChatGPT/Codex transport for the blind semantic challenger.
 *
 * This class owns only provider conversation state. It has no repository reader,
 * mutation, review-verdict, publication, or recovery authority. The shadow runner
 * remains responsible for challenge-owned repository evidence and durable receipts.
 * Provider thread state is intentionally process-local: after a crash the durable
 * challenge trajectory makes the runner fail closed and a fresh challenge identity
 * is required rather than synthesizing provider recovery.
 *
 * The provider filesystem capability is also blind: both directories supplied to
 * the read-only semantic client must be canonical, empty, and mutually disjoint on
 * every turn. A normal Web-A authority/bundle directory therefore cannot be reused
 * as challenger context even when prompt construction itself remains blind.
 */
export class ChatGptCodexSemanticChallengeTransport implements SemanticChallengeTransport {
  private readonly states = new Map<string, ChallengeState>();
  private readonly idempotency = new Map<string, string>();

  constructor(private readonly options: {
    client: ChatGptCodexSemanticClient;
    profile: AgentProfile;
    limits: AgentLimits;
    scratchDirectory: string;
    authorityDirectory: string;
    beforeTurn?: () => Promise<void>;
    now?: () => Date;
  }) {}

  private now(): Date {
    const value = (this.options.now ?? (() => new Date()))();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("semantic challenge provider clock is invalid.");
    return value;
  }

  private state(jobId: string): ChallengeState {
    const state = this.states.get(jobId);
    if (!state) throw new Error("semantic challenge provider job is unknown or no longer recoverable.");
    return state;
  }

  private pruneExpired(nowMs: number): void {
    const removed = new Set<string>();
    for (const [jobId, state] of this.states) {
      const expires = Date.parse(state.identity.expires_at);
      if (Number.isFinite(expires) && nowMs >= expires) {
        this.states.delete(jobId);
        removed.add(jobId);
      }
    }
    if (removed.size === 0) return;
    for (const [key, jobId] of this.idempotency) if (removed.has(jobId)) this.idempotency.delete(key);
  }

  private assertBudget(state: ChallengeState, beforeTurn: boolean): void {
    const nowMs = this.now().getTime();
    const created = Date.parse(state.identity.created_at);
    const expires = Date.parse(state.identity.expires_at);
    if (!Number.isFinite(created) || !Number.isFinite(expires) || nowMs < created || nowMs >= expires
      || (beforeTurn && state.usage.turns >= this.options.limits.maximum_total_agent_turns)
      || state.usage.input_tokens > this.options.limits.maximum_total_input_tokens
      || state.usage.output_tokens > this.options.limits.maximum_total_output_tokens) {
      throw new Error("semantic challenge provider budget is exhausted.");
    }
  }

  private recordUsage(state: ChallengeState, usage: Usage): void {
    const input = safeUsage(usage.input_tokens, "input-token");
    const cached = safeUsage(usage.cached_input_tokens, "cached-input-token");
    const output = safeUsage(usage.output_tokens, "output-token");
    if (cached > input) throw new Error("semantic challenge cached input usage exceeds total input usage.");
    state.usage.turns = safeAdd(state.usage.turns, 1);
    state.usage.input_tokens = safeAdd(state.usage.input_tokens, input);
    state.usage.cached_input_tokens = safeAdd(state.usage.cached_input_tokens, cached);
    state.usage.output_tokens = safeAdd(state.usage.output_tokens, output);
    this.assertBudget(state, false);
  }

  private async assertBlindFilesystem(): Promise<void> {
    const scratch = path.resolve(this.options.scratchDirectory);
    const authority = path.resolve(this.options.authorityDirectory);
    if (scratch === authority || scratch.startsWith(`${authority}${path.sep}`) || authority.startsWith(`${scratch}${path.sep}`)) {
      throw new Error("semantic challenge provider directories must be independent blind roots.");
    }
    await assertEmptyCanonicalDirectory(scratch, "scratch");
    await assertEmptyCanonicalDirectory(authority, "authority");
  }

  async createSemanticChallengeJob(requestValue: SemanticChallengeRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    if (!SAFE_JOB_ID.test(idempotencyKey)) throw new Error("semantic challenge provider idempotency identity is invalid.");
    const request = createSemanticChallengeRequest({ challengeId: requestValue.challenge_id, repository: requestValue.repository, originalGoal: requestValue.original_goal });
    const requestDigest = contentDigest(request);
    const now = this.now();
    this.pruneExpired(now.getTime());
    const existingJob = this.idempotency.get(idempotencyKey);
    if (existingJob) {
      const existing = this.state(existingJob);
      if (contentDigest(existing.request) !== requestDigest) throw new Error("semantic challenge provider idempotency replay conflicts with another request.");
      return structuredClone(existing.identity);
    }
    if (this.states.size >= MAX_PROVIDER_JOBS) throw new Error("semantic challenge provider active job bound is exhausted.");
    const job_id = `challenge-${contentDigest({ idempotencyKey, request }).slice(0, 48)}`;
    if (!SAFE_JOB_ID.test(job_id)) throw new Error("semantic challenge provider generated an invalid job identity.");
    const configuredAgeMs = this.options.limits.maximum_total_seconds * 1_000;
    const jobAgeMs = Number.isSafeInteger(configuredAgeMs) && configuredAgeMs > 0 ? Math.min(MAX_JOB_AGE_MS, configuredAgeMs) : MAX_JOB_AGE_MS;
    const identity: BridgeJobIdentity = {
      protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
      job_id,
      owner: OWNER,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + jobAgeMs).toISOString(),
      content_sha256: requestDigest,
    };
    this.states.set(job_id, {
      request,
      identity,
      sequence: 0,
      usage: { turns: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
      result_replays: new Map(),
      turn_state: "idle",
    });
    this.idempotency.set(idempotencyKey, job_id);
    return structuredClone(identity);
  }

  async waitForSemanticChallengeAction(jobId: string, afterSequence: number, signal?: AbortSignal): Promise<SemanticChallengeRemoteAction | null> {
    const state = this.state(jobId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence !== state.sequence) throw new Error("semantic challenge provider sequence cursor is stale or invalid.");
    if (state.sealed) return null;
    if (state.turn_state === "ambiguous") throw new Error("semantic challenge provider turn is ambiguous and cannot be replayed.");
    if (state.turn_state === "in_flight") throw new Error("semantic challenge provider turn is already in flight.");
    if (state.awaiting_result_request_id) throw new Error("semantic challenge provider cannot advance before the pending repository result is submitted.");
    this.assertBudget(state, true);
    state.turn_state = "in_flight";

    let prompt: string;
    try {
      await this.assertBlindFilesystem();
      if (this.options.beforeTurn) await this.options.beforeTurn();
      await this.assertBlindFilesystem();
      prompt = state.pending_result ? followupPrompt(state.pending_result.request_id, state.pending_result) : wirePrompt(state.request);
      delete state.pending_result;
    } catch (error) {
      state.turn_state = "idle";
      throw error;
    }

    try {
      const response = await this.options.client.turn({
        profile: this.options.profile,
        prompt,
        scratchDirectory: this.options.scratchDirectory,
        authorityDirectory: this.options.authorityDirectory,
        ...(state.thread_id ? { threadId: state.thread_id } : {}),
        ...(signal ? { signal } : {}),
      });
      this.recordUsage(state, response.usage);
      if (state.thread_id && response.thread_id !== state.thread_id) throw new Error("semantic challenge provider thread identity drifted.");
      state.thread_id = response.thread_id;

      const provider = parseProviderEnvelope(response.output);
      const nextSequence = state.sequence + 1;
      if (provider.kind === "repository_command") {
        const command = parseRepositoryCommand(provider.payload);
        const request_id = `remote-${String(nextSequence).padStart(3, "0")}-${contentDigest(command).slice(0, 20)}`;
        state.sequence = nextSequence;
        state.awaiting_result_request_id = request_id;
        state.turn_state = "idle";
        return { sequence: nextSequence, type: "repository_command", request_id, command };
      }
      const envelope = opaqueUnderstanding(provider.payload);
      state.sequence = nextSequence;
      state.sealed = envelope;
      state.turn_state = "idle";
      return { sequence: nextSequence, type: "semantic_understanding_sealed", envelope: structuredClone(envelope) };
    } catch (error) {
      state.turn_state = "ambiguous";
      throw error;
    }
  }

  async submitSemanticChallengeRepositoryResult(jobId: string, result: RepositoryCommandResult, idempotencyKey: string): Promise<void> {
    if (!SAFE_JOB_ID.test(idempotencyKey)) throw new Error("semantic challenge provider result idempotency identity is invalid.");
    const state = this.state(jobId);
    if (state.turn_state !== "idle") throw new Error("semantic challenge provider cannot accept a repository result while its provider state is not idle.");
    const resultDigest = contentDigest(result);
    const replay = state.result_replays.get(idempotencyKey);
    if (replay) {
      if (replay !== resultDigest) throw new Error("semantic challenge provider result idempotency replay conflicts with prior result.");
      return;
    }
    const expected = state.awaiting_result_request_id;
    if (!expected) throw new Error("semantic challenge provider has no pending repository request.");
    if (result.request_id !== expected) throw new Error("semantic challenge provider repository result request identity mismatched.");
    state.pending_result = structuredClone(result);
    delete state.awaiting_result_request_id;
    state.result_replays.set(idempotencyKey, resultDigest);
  }

  async receiveSemanticUnderstanding(jobId: string): Promise<SemanticUnderstandingEnvelope | null> {
    const sealed = this.state(jobId).sealed;
    return sealed ? structuredClone(sealed) : null;
  }
}
