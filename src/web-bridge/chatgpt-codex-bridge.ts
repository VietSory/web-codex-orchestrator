import crypto from "node:crypto";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import type { AgentLimits, TrustedConfig } from "../config/contracts.js";
import { defaultAgentLimits } from "../execution/budget.js";
import { readPreparationForExecution } from "../execution/execution-store.js";
import { ensureChatGptLogin } from "../runtime/chatgpt-login.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { ensureCanonicalDirectory } from "../shared/safe-directory.js";
import { parseChatGptCodexAuthority } from "./chatgpt-codex-authority.js";
import { ChatGptCodexImplementationClient } from "./chatgpt-codex-implementation-client.js";
import { chatGptCodexAuthorPrompt, chatGptCodexClarificationPrompt, chatGptCodexRepositoryResultPrompt, chatGptCodexReviewPrompt } from "./chatgpt-codex-prompts.js";
import { prepareChatGptCodexReviewEvidence } from "./chatgpt-codex-review-evidence.js";
import { ChatGptCodexSemanticClient } from "./chatgpt-codex-semantic-client.js";
import { WebBridgeError, contentDigest, parseWebContractEnvelope, parseWebImplementationSubmission, parseWebVerdictEnvelope, type AuthoringEvent, type BridgeConnectionStatus, type BridgeJobIdentity, type FinalReviewRequest, type RepositoryCommandResult, type WebContractEnvelope, type WebImplementationSubmission, type WebVerdictEnvelope } from "./contracts.js";
import type { PreparedRunAwareWebBridge } from "./prepared-run-aware.js";
import { RelayFileStore } from "./relay/file-store.js";
import { toAuthoringEvent, type RelayJobRecord } from "./relay/protocol.js";
import type { AuthoringJobRequest, WebBridge } from "./web-bridge.js";

const OWNER = "local-chatgpt-codex";
const PROVIDER_USAGE_EVENT = "chatgpt_codex_provider_usage";
export const CHATGPT_CODEX_AUTH_REQUIRED_ACCOUNT = "ChatGPT authorization required";

type RelayEvents = Awaited<ReturnType<RelayFileStore["events"]>>;
type ProviderUsage = { input_tokens: number; cached_input_tokens: number; output_tokens: number };

function threadId(events: RelayEvents): string | undefined {
  const event = events.slice().reverse().find((value) => value.type === "chatgpt_codex_thread");
  const value = event?.payload as { thread_id?: unknown } | undefined;
  return typeof value?.thread_id === "string" ? value.thread_id : undefined;
}

function preparedRunId(events: RelayEvents): string | null {
  const event = events.slice().reverse().find((value) => value.type === "chatgpt_codex_prepared_run");
  const value = event?.payload as { run_id?: unknown } | undefined;
  return typeof value?.run_id === "string" ? value.run_id : null;
}

function relayRunId(record: RelayJobRecord): string | null {
  if (record.kind === "authoring") return preparedRunId(record.events);
  const runId = (record.request as FinalReviewRequest).run_id;
  return typeof runId === "string" ? runId : null;
}

function hasUnresolvedReservation(events: RelayEvents, reservationType: string, completionTypes: readonly string[]): boolean {
  const reservation = events.slice().reverse().find((event) => event.type === reservationType);
  if (!reservation) return false;
  return !events.some((event) => event.sequence > reservation.sequence && completionTypes.includes(event.type));
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function safeTokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new WebBridgeError("WEB_CHATGPT_CODEX_USAGE_INVALID", `Durable provider ${label} usage is invalid.`);
  return value as number;
}

function addSafe(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_EXHAUSTED", "Provider usage exceeded safe integer accounting bounds.");
  return value;
}

function accumulatedProviderUsage(events: RelayEvents): { turns: number; input_tokens: number; cached_input_tokens: number; output_tokens: number } {
  let turns = 0, input = 0, cached = 0, output = 0;
  for (const event of events) {
    if (event.type !== PROVIDER_USAGE_EVENT) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new WebBridgeError("WEB_CHATGPT_CODEX_USAGE_INVALID", "Durable provider usage event is invalid.");
    const item = payload as Record<string, unknown>;
    if (!(["author", "implementation", "review"] as const).includes(item.phase as "author" | "implementation" | "review")) throw new WebBridgeError("WEB_CHATGPT_CODEX_USAGE_INVALID", "Durable provider usage phase is invalid.");
    const turnInput = safeTokenCount(item.input_tokens, "input-token");
    const turnCached = safeTokenCount(item.cached_input_tokens, "cached-input-token");
    const turnOutput = safeTokenCount(item.output_tokens, "output-token");
    if (turnCached > turnInput) throw new WebBridgeError("WEB_CHATGPT_CODEX_USAGE_INVALID", "Durable cached-input usage exceeds total input usage.");
    input = addSafe(input, turnInput);
    cached = addSafe(cached, turnCached);
    output = addSafe(output, turnOutput);
    turns += 1;
  }
  return { turns, input_tokens: input, cached_input_tokens: cached, output_tokens: output };
}

function assertProviderBudget(events: RelayEvents, limits: AgentLimits, beforeTurn: boolean): void {
  const usage = accumulatedProviderUsage(events);
  if ((beforeTurn && usage.turns >= limits.maximum_total_agent_turns) || usage.input_tokens > limits.maximum_total_input_tokens || usage.output_tokens > limits.maximum_total_output_tokens) {
    throw new WebBridgeError("WEB_CHATGPT_CODEX_BUDGET_EXHAUSTED", "Configured local ChatGPT/Codex provider budget is exhausted.");
  }
}

function providerBusy(): WebBridgeError {
  return new WebBridgeError("WEB_CHATGPT_CODEX_PROVIDER_BUSY", "Another WCO process already owns this exact provider turn; refusing a duplicate model call.");
}

export class ChatGptCodexWebBridge implements WebBridge, PreparedRunAwareWebBridge {
  private readonly store: RelayFileStore;
  private readonly stateDirectory: string;
  private readonly scratchDirectory: string;
  private readonly authorityDirectory: string;
  private semantic: ChatGptCodexSemanticClient | null = null;
  private implementation: ChatGptCodexImplementationClient | null = null;

  constructor(private readonly config: TrustedConfig, bridgeDirectory: string, stateDirectory = path.join(path.dirname(path.resolve(bridgeDirectory)), "state")) {
    this.store = new RelayFileStore(path.join(bridgeDirectory, "chatgpt-codex"));
    this.stateDirectory = path.resolve(stateDirectory);
    this.scratchDirectory = path.join(bridgeDirectory, "chatgpt-codex-runtime", "scratch");
    this.authorityDirectory = path.join(bridgeDirectory, "chatgpt-codex-runtime", "authority");
  }

  private limits(): AgentLimits { return this.config.agents?.limits ?? defaultAgentLimits(); }

  private async providerBudgetEventsForRun(runId: string): Promise<RelayEvents> {
    const records = await this.store.list(OWNER);
    return records.filter((record) => relayRunId(record) === runId).flatMap((record) => record.events);
  }

  private async providerBudgetEventsForJob(jobId: string, current?: RelayJobRecord): Promise<RelayEvents> {
    const record = current ?? await this.store.get(jobId, OWNER);
    const runId = relayRunId(record);
    return runId ? await this.providerBudgetEventsForRun(runId) : record.events;
  }

  private async assertProviderBudgetForJob(jobId: string, current: RelayJobRecord, beforeTurn: boolean): Promise<void> {
    assertProviderBudget(await this.providerBudgetEventsForJob(jobId, current), this.limits(), beforeTurn);
  }

  private async assertProviderBudgetForRun(runId: string, beforeTurn: boolean): Promise<void> {
    assertProviderBudget(await this.providerBudgetEventsForRun(runId), this.limits(), beforeTurn);
  }

  private async rawAgent(): Promise<CodexSdkAgentClient> {
    const runtime = await resolveCodexRuntime(this.config.runtime, this.stateDirectory);
    return new CodexSdkAgentClient(runtime);
  }

  private async client(): Promise<ChatGptCodexSemanticClient> {
    if (this.semantic) return this.semantic;
    this.semantic = new ChatGptCodexSemanticClient(await this.rawAgent(), this.limits().maximum_turn_seconds);
    return this.semantic;
  }

  private async implementationClient(): Promise<ChatGptCodexImplementationClient> {
    if (this.implementation) return this.implementation;
    this.implementation = new ChatGptCodexImplementationClient(await this.rawAgent(), this.limits().maximum_turn_seconds);
    return this.implementation;
  }

  private async ensureAuthorizedForProviderTurn(): Promise<void> {
    const authorized = await ensureChatGptLogin({ config: this.config, stateDirectory: this.stateDirectory });
    if (!authorized) throw new WebBridgeError("CODEX_AUTH_UNAVAILABLE", "ChatGPT authorization is required. Run `wco web connect` in an interactive terminal.");
  }

  private async recordProviderUsage(jobId: string, phase: "author" | "implementation" | "review", key: string, usage: ProviderUsage): Promise<void> {
    const input = safeTokenCount(usage.input_tokens, "input-token");
    const cached = safeTokenCount(usage.cached_input_tokens, "cached-input-token");
    const output = safeTokenCount(usage.output_tokens, "output-token");
    if (cached > input) throw new WebBridgeError("WEB_CHATGPT_CODEX_USAGE_INVALID", "Provider cached-input usage exceeds total input usage.");
    const payload = { phase, input_tokens: input, cached_input_tokens: cached, output_tokens: output };
    await this.store.append(jobId, OWNER, PROVIDER_USAGE_EVENT, payload, `usage-${phase}-${key.slice(0, 96)}`);
    const latest = await this.store.get(jobId, OWNER);
    await this.assertProviderBudgetForJob(jobId, latest, false);
  }

  private async turn(prompt: string, existingThreadId?: string, signal?: AbortSignal, reserve?: (claimNonce: string) => Promise<boolean>): Promise<{ thread_id: string; output: unknown; usage: ProviderUsage }> {
    await this.ensureAuthorizedForProviderTurn();
    await ensureCanonicalDirectory(this.scratchDirectory, "ChatGPT/Codex semantic scratch");
    await ensureCanonicalDirectory(this.authorityDirectory, "ChatGPT/Codex semantic authority");
    const profile = this.config.agents?.final_reviewer;
    if (!profile) throw new WebBridgeError("WEB_CHATGPT_CODEX_CONFIG_INVALID", "Semantic reviewer profile is missing.");
    const client = await this.client();
    if (reserve && !await reserve(crypto.randomUUID())) throw providerBusy();
    return await client.turn({ profile, prompt, scratchDirectory: this.scratchDirectory, authorityDirectory: this.authorityDirectory, ...(existingThreadId ? { threadId: existingThreadId } : {}), ...(signal ? { signal } : {}) });
  }

  async createAuthoringJob(request: AuthoringJobRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    if (process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== "true") await this.ensureAuthorizedForProviderTurn();
    return await this.store.create("authoring", OWNER, request, idempotencyKey, request.ttl_seconds);
  }

  async waitForAuthoringEvent(jobId: string, afterSequence: number, signal?: AbortSignal): Promise<AuthoringEvent | null> {
    const record = await this.store.get(jobId, OWNER);
    if (record.kind !== "authoring") throw new WebBridgeError("WEB_JOB_KIND_INVALID", "Requested job is not an authoring job.");
    for (const event of record.events.filter((value) => value.sequence > afterSequence)) { const authoring = toAuthoringEvent(event); if (authoring) return authoring; }
    if (record.events.some((event) => event.type === "contract_sealed")) {
      const submission = await this.receiveWebImplementation(jobId);
      if (!submission) return null;
      const refreshed = await this.store.get(jobId, OWNER);
      for (const event of refreshed.events.filter((value) => value.sequence > afterSequence)) {
        const authoring = toAuthoringEvent(event);
        if (authoring) return authoring;
      }
      return null;
    }
    if (hasUnresolvedReservation(record.events, "chatgpt_codex_authoring_reserved", ["repository_command", "contract_sealed"])) throw new WebBridgeError("WEB_CHATGPT_CODEX_AMBIGUOUS_AUTHORING", "A prior semantic author turn may have completed without durable authority; WCO refuses to replay an ambiguous contract/repository decision.");
    const lastAuthority = record.events.slice().reverse().find((event) => ["repository_command", "contract_sealed"].includes(event.type));
    const latestResult = record.events.slice().reverse().find((event) => event.type === "repository_command_result" && (!lastAuthority || event.sequence > lastAuthority.sequence));
    const latestClarification = record.events.slice().reverse().find((event) => event.type === "user_clarification" && (!lastAuthority || event.sequence > lastAuthority.sequence));
    if (lastAuthority?.type === "repository_command" && !latestResult && !latestClarification) return null;
    await this.assertProviderBudgetForJob(jobId, record, true);
    const request = record.request as AuthoringJobRequest;
    const prompt = latestResult
      ? chatGptCodexRepositoryResultPrompt(latestResult.payload, request, jobId)
      : latestClarification
        ? chatGptCodexClarificationPrompt(latestClarification.payload, request, jobId)
        : chatGptCodexAuthorPrompt(request, jobId);
    const existingThread = threadId(record.events);
    const inputSha256 = contentDigest({ prompt, thread_id: existingThread ?? null });
    const result = await this.turn(prompt, existingThread, signal, async (claimNonce) => (await this.store.claim(jobId, OWNER, "chatgpt_codex_authoring_reserved", { input_sha256: inputSha256, thread_id: existingThread ?? null }, `author-reserve-${inputSha256}`, claimNonce)).acquired);
    await this.recordProviderUsage(jobId, "author", inputSha256, result.usage);
    await this.store.append(jobId, OWNER, "chatgpt_codex_thread", { thread_id: result.thread_id }, `thread-${contentDigest({ jobId, inputSha256, thread: result.thread_id })}`);
    const authority = parseChatGptCodexAuthority(result.output);
    if (authority.kind === "repository_command") {
      const requestId = `repo-${contentDigest({ jobId, sequence: record.events.at(-1)?.sequence ?? 0, command: authority.value }).slice(0, 24)}`;
      const stored = await this.store.append(jobId, OWNER, "repository_command", { request_id: requestId, command: authority.value }, `semantic-${contentDigest(result.output)}`);
      return toAuthoringEvent(stored);
    }
    if (authority.kind === "contract_sealed") {
      if (authority.value.job_id !== jobId || contentDigest(authority.value.repository) !== contentDigest(request.repository) || authority.value.user_intent !== request.user_intent) throw new WebBridgeError("WEB_CHATGPT_CODEX_BINDING_MISMATCH", "Semantic contract is stale or bound to another repository/intent.");
      const stored = await this.store.append(jobId, OWNER, "contract_sealed", { envelope: authority.value }, `semantic-${contentDigest(result.output)}`);
      return toAuthoringEvent(stored);
    }
    throw new WebBridgeError("WEB_CHATGPT_CODEX_PHASE_INVALID", "Authoring can only request repository context or seal a contract.");
  }

  async submitRepositoryCommandResult(jobId: string, result: RepositoryCommandResult, idempotencyKey: string): Promise<void> { await this.store.append(jobId, OWNER, "repository_command_result", result, idempotencyKey); }
  async submitClarification(jobId: string, text: string, idempotencyKey: string): Promise<void> { await this.store.append(jobId, OWNER, "user_clarification", { text }, idempotencyKey); }

  async receiveSealedContract(jobId: string): Promise<WebContractEnvelope | null> {
    const event = (await this.store.events(jobId, OWNER, 0)).slice().reverse().find((value) => value.type === "contract_sealed");
    return event ? parseWebContractEnvelope((event.payload as { envelope?: unknown }).envelope ?? event.payload) : null;
  }

  async receiveWebImplementation(jobId: string): Promise<WebImplementationSubmission | null> {
    const record = await this.store.get(jobId, OWNER);
    if (record.kind !== "authoring") throw new WebBridgeError("WEB_JOB_KIND_INVALID", "Requested job is not an authoring job.");
    const existing = record.events.slice().reverse().find((value) => value.type === "implementation_sealed");
    if (existing) return parseWebImplementationSubmission((existing.payload as { submission?: unknown }).submission ?? existing.payload);
    const runId = preparedRunId(record.events);
    if (!runId) return null;
    if (!record.events.some((event) => event.type === "contract_sealed")) throw new WebBridgeError("WEB_CHATGPT_CODEX_PHASE_INVALID", "Implementation proposal requires a sealed semantic contract.");
    if (record.events.some((event) => event.type === "chatgpt_codex_implementation_reserved")) throw new WebBridgeError("WEB_CHATGPT_CODEX_AMBIGUOUS_IMPLEMENTATION", "A prior implementation provider turn may have started without a durable result; WCO refuses to replay an ambiguous mutation proposal.");
    await this.assertProviderBudgetForJob(jobId, record, true);
    await this.ensureAuthorizedForProviderTurn();
    const preparation = await readPreparationForExecution(this.stateDirectory, runId);
    const profile = this.config.agents?.implementer;
    if (!profile) throw new WebBridgeError("WEB_CHATGPT_CODEX_CONFIG_INVALID", "Harness implementer profile is missing.");
    const client = await this.implementationClient();
    const usageKey = contentDigest({ jobId, runId });
    const claim = await this.store.claim(jobId, OWNER, "chatgpt_codex_implementation_reserved", { run_id: runId }, `implementation-reserve-${usageKey}`, crypto.randomUUID());
    if (!claim.acquired) throw providerBusy();
    const proposal = await client.propose({ profile, jobId, runId, workspacePath: preparation.receipt.worktree_path, acceptedBundlePath: preparation.receipt.accepted_bundle_path });
    await this.recordProviderUsage(jobId, "implementation", usageKey, proposal.usage);
    await this.store.append(jobId, OWNER, "implementation_sealed", { submission: proposal.submission }, `implementation-${contentDigest(proposal.submission)}`);
    return proposal.submission;
  }

  async bindPreparedRun(jobId: string, runId: string, idempotencyKey: string): Promise<void> {
    const record = await this.store.get(jobId, OWNER);
    if (record.kind !== "authoring") throw new WebBridgeError("WEB_JOB_KIND_INVALID", "Prepared run binding is valid only for an authoring job.");
    const sealed = record.events.slice().reverse().find((event) => event.type === "contract_sealed");
    if (!sealed) throw new WebBridgeError("WEB_CHATGPT_CODEX_PHASE_INVALID", "Prepared run binding requires a sealed semantic contract.");
    const envelope = parseWebContractEnvelope((sealed.payload as { envelope?: unknown }).envelope ?? sealed.payload);
    if (envelope.job_id !== jobId) throw new WebBridgeError("WEB_CHATGPT_CODEX_BINDING_MISMATCH", "Prepared run contract is bound to another authoring job.");
    const separator = runId.lastIndexOf(":");
    const taskId = separator > 0 ? runId.slice(0, separator) : "";
    const archiveSha256 = separator > 0 ? runId.slice(separator + 1) : "";
    const expectedTaskId = `TASK-${contentDigest(envelope).slice(0, 32).toUpperCase()}`;
    if (taskId !== expectedTaskId || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new WebBridgeError("WEB_CHATGPT_CODEX_BINDING_MISMATCH", "Prepared run identity does not derive from the exact sealed contract.");
    const existing = preparedRunId(record.events);
    if (existing) { if (existing !== runId) throw new WebBridgeError("WEB_CHATGPT_CODEX_BINDING_MISMATCH", "Authoring job is already bound to a different canonical prepared run."); return; }
    await this.store.append(jobId, OWNER, "chatgpt_codex_prepared_run", { run_id: runId }, idempotencyKey);
  }

  async preflightFinalReviewEvidence(evidence: Record<string, unknown>): Promise<void> {
    prepareChatGptCodexReviewEvidence(evidence);
  }

  async createFinalReviewJob(request: FinalReviewRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    const replay = (await this.store.list(OWNER)).some((record) => Object.prototype.hasOwnProperty.call(record.idempotency, `create:${idempotencyKey}`));
    if (replay) return await this.store.create("final_review", OWNER, request, idempotencyKey, 86_400);
    await this.assertProviderBudgetForRun(request.run_id, true);
    return await this.store.create("final_review", OWNER, request, idempotencyKey, 86_400);
  }

  async submitFinalReviewEvidence(reviewId: string, evidence: Record<string, unknown>, idempotencyKey: string): Promise<void> { await this.store.append(reviewId, OWNER, "final_review_evidence", evidence, idempotencyKey); }

  async waitForVerdict(reviewId: string, signal?: AbortSignal): Promise<WebVerdictEnvelope | null> {
    const record = await this.store.get(reviewId, OWNER);
    if (record.kind !== "final_review") throw new WebBridgeError("WEB_JOB_KIND_INVALID", "Requested job is not a final review job.");
    const existing = record.events.slice().reverse().find((value) => value.type === "web_verdict");
    if (existing) return parseWebVerdictEnvelope((existing.payload as { verdict?: unknown }).verdict ?? existing.payload);
    const evidence = record.events.slice().reverse().find((value) => value.type === "final_review_evidence");
    if (!evidence) return null;
    if (hasUnresolvedReservation(record.events, "chatgpt_codex_review_reserved", ["web_verdict"])) throw new WebBridgeError("WEB_CHATGPT_CODEX_AMBIGUOUS_REVIEW", "A prior semantic review turn may have completed without a durable verdict; WCO refuses to replay an ambiguous authority-bearing review.");
    await this.assertProviderBudgetForJob(reviewId, record, true);
    const request = record.request as FinalReviewRequest;
    const readableEvidence = prepareChatGptCodexReviewEvidence(evidence.payload as Record<string, unknown>);
    const prompt = chatGptCodexReviewPrompt(request, readableEvidence, reviewId);
    const inputSha256 = contentDigest({ reviewId, prompt });
    const result = await this.turn(prompt, undefined, signal, async (claimNonce) => (await this.store.claim(reviewId, OWNER, "chatgpt_codex_review_reserved", { input_sha256: inputSha256 }, `review-reserve-${inputSha256}`, claimNonce)).acquired);
    await this.recordProviderUsage(reviewId, "review", inputSha256, result.usage);
    await this.store.append(reviewId, OWNER, "chatgpt_codex_review_thread", { thread_id: result.thread_id }, `review-thread-${contentDigest({ reviewId, inputSha256, thread: result.thread_id })}`);
    const authority = parseChatGptCodexAuthority(result.output);
    if (authority.kind !== "web_verdict") throw new WebBridgeError("WEB_CHATGPT_CODEX_PHASE_INVALID", "Final review must return a Web verdict.");
    if (authority.value.review_id !== reviewId || authority.value.run_id !== request.run_id || authority.value.result_bundle_sha256 !== request.result_bundle_sha256) throw new WebBridgeError("WEB_CHATGPT_CODEX_BINDING_MISMATCH", "Semantic verdict is stale or bound to another review/run/result bundle.");
    await this.store.append(reviewId, OWNER, "web_verdict", { verdict: authority.value }, `semantic-${contentDigest(result.output)}`);
    return authority.value;
  }

  async getConnectionStatus(): Promise<BridgeConnectionStatus> {
    try { await (await this.client()).checkAvailability(); return { configured: true, connected: true, account: "ChatGPT via bundled Codex" }; }
    catch (error) { if (errorCode(error) === "CODEX_AUTH_UNAVAILABLE") return { configured: true, connected: true, account: CHATGPT_CODEX_AUTH_REQUIRED_ACCOUNT }; return { configured: true, connected: false }; }
  }
}
