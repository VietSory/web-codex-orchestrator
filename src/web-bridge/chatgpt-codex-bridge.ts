import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import type { TrustedConfig } from "../config/contracts.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { parseChatGptCodexAuthority } from "./chatgpt-codex-authority.js";
import { chatGptCodexAuthorPrompt, chatGptCodexRepositoryResultPrompt, chatGptCodexReviewPrompt } from "./chatgpt-codex-prompts.js";
import { ChatGptCodexSemanticClient } from "./chatgpt-codex-semantic-client.js";
import { WebBridgeError, contentDigest, parseWebContractEnvelope, parseWebVerdictEnvelope, type AuthoringEvent, type BridgeConnectionStatus, type BridgeJobIdentity, type FinalReviewRequest, type RepositoryCommandResult, type WebContractEnvelope, type WebImplementationSubmission, type WebVerdictEnvelope } from "./contracts.js";
import type { PreparedRunAwareWebBridge } from "./prepared-run-aware.js";
import { RelayFileStore } from "./relay/file-store.js";
import { toAuthoringEvent } from "./relay/protocol.js";
import type { AuthoringJobRequest, WebBridge } from "./web-bridge.js";

const OWNER = "local-chatgpt-codex";

function threadId(events: Awaited<ReturnType<RelayFileStore["events"]>>): string | undefined {
  const event = events.slice().reverse().find((value) => value.type === "chatgpt_codex_thread");
  const value = event?.payload as { thread_id?: unknown } | undefined;
  return typeof value?.thread_id === "string" ? value.thread_id : undefined;
}

export class ChatGptCodexWebBridge implements WebBridge, PreparedRunAwareWebBridge {
  private readonly store: RelayFileStore;
  private readonly stateDirectory: string;
  private readonly scratchDirectory: string;
  private readonly authorityDirectory: string;
  private semantic: ChatGptCodexSemanticClient | null = null;

  constructor(private readonly config: TrustedConfig, bridgeDirectory: string) {
    this.store = new RelayFileStore(path.join(bridgeDirectory, "chatgpt-codex"));
    this.stateDirectory = path.dirname(path.resolve(bridgeDirectory));
    this.scratchDirectory = path.join(bridgeDirectory, "chatgpt-codex-runtime", "scratch");
    this.authorityDirectory = path.join(bridgeDirectory, "chatgpt-codex-runtime", "authority");
  }

  private async client(): Promise<ChatGptCodexSemanticClient> {
    if (this.semantic) return this.semantic;
    const runtime = await resolveCodexRuntime(this.config.runtime, this.stateDirectory);
    this.semantic = new ChatGptCodexSemanticClient(new CodexSdkAgentClient(runtime));
    return this.semantic;
  }

  private async turn(prompt: string, existingThreadId?: string, signal?: AbortSignal): Promise<{ thread_id: string; output: unknown }> {
    await mkdir(this.scratchDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.authorityDirectory, { recursive: true, mode: 0o700 });
    const profile = this.config.agents?.final_reviewer;
    if (!profile) throw new WebBridgeError("WEB_CHATGPT_CODEX_CONFIG_INVALID", "Semantic reviewer profile is missing.");
    return await (await this.client()).turn({ profile, prompt, scratchDirectory: this.scratchDirectory, authorityDirectory: this.authorityDirectory, ...(existingThreadId ? { threadId: existingThreadId } : {}), ...(signal ? { signal } : {}) });
  }

  async createAuthoringJob(request: AuthoringJobRequest, idempotencyKey: string): Promise<BridgeJobIdentity> {
    return await this.store.create("authoring", OWNER, request, idempotencyKey, request.ttl_seconds);
  }

  async waitForAuthoringEvent(jobId: string, afterSequence: number, signal?: AbortSignal): Promise<AuthoringEvent | null> {
    const record = await this.store.get(jobId, OWNER);
    if (record.kind !== "authoring") throw new WebBridgeError("WEB_JOB_KIND_INVALID", "Requested job is not an authoring job.");
    for (const event of record.events.filter((value) => value.sequence > afterSequence)) {
      const authoring = toAuthoringEvent(event);
      if (authoring) return authoring;
    }
    if (record.events.some((event) => event.type === "contract_sealed")) return null;
    const lastAuthority = record.events.slice().reverse().find((event) => ["repository_command", "contract_sealed"].includes(event.type));
    const latestResult = record.events.slice().reverse().find((event) => event.type === "repository_command_result" && (!lastAuthority || event.sequence > lastAuthority.sequence));
    const latestClarification = record.events.slice().reverse().find((event) => event.type === "user_clarification" && (!lastAuthority || event.sequence > lastAuthority.sequence));
    if (lastAuthority?.type === "repository_command" && !latestResult && !latestClarification) return null;
    const request = record.request as AuthoringJobRequest;
    const prompt = latestResult ? chatGptCodexRepositoryResultPrompt(latestResult.payload) : latestClarification ? `${chatGptCodexAuthorPrompt(request)}\nUser clarification: ${JSON.stringify(latestClarification.payload)}` : chatGptCodexAuthorPrompt(request);
    const result = await this.turn(prompt, threadId(record.events), signal);
    await this.store.append(jobId, OWNER, "chatgpt_codex_thread", { thread_id: result.thread_id }, `thread-${contentDigest({ jobId, afterSequence, thread: result.thread_id })}`);
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

  async receiveWebImplementation(_jobId: string): Promise<WebImplementationSubmission | null> { return null; }

  async bindPreparedRun(jobId: string, runId: string, idempotencyKey: string): Promise<void> {
    await this.store.append(jobId, OWNER, "chatgpt_codex_prepared_run", { run_id: runId }, idempotencyKey);
  }

  async createFinalReviewJob(request: FinalReviewRequest, idempotencyKey: string): Promise<BridgeJobIdentity> { return await this.store.create("final_review", OWNER, request, idempotencyKey, 86_400); }
  async submitFinalReviewEvidence(reviewId: string, evidence: Record<string, unknown>, idempotencyKey: string): Promise<void> { await this.store.append(reviewId, OWNER, "final_review_evidence", evidence, idempotencyKey); }

  async waitForVerdict(reviewId: string, signal?: AbortSignal): Promise<WebVerdictEnvelope | null> {
    const record = await this.store.get(reviewId, OWNER);
    if (record.kind !== "final_review") throw new WebBridgeError("WEB_JOB_KIND_INVALID", "Requested job is not a final review job.");
    const existing = record.events.slice().reverse().find((value) => value.type === "web_verdict");
    if (existing) return parseWebVerdictEnvelope((existing.payload as { verdict?: unknown }).verdict ?? existing.payload);
    const evidence = record.events.slice().reverse().find((value) => value.type === "final_review_evidence");
    if (!evidence) return null;
    const request = record.request as FinalReviewRequest;
    const result = await this.turn(chatGptCodexReviewPrompt(request, evidence.payload as Record<string, unknown>), undefined, signal);
    const authority = parseChatGptCodexAuthority(result.output);
    if (authority.kind !== "web_verdict") throw new WebBridgeError("WEB_CHATGPT_CODEX_PHASE_INVALID", "Final review must return a Web verdict.");
    if (authority.value.review_id !== reviewId || authority.value.run_id !== request.run_id || authority.value.result_bundle_sha256 !== request.result_bundle_sha256) throw new WebBridgeError("WEB_CHATGPT_CODEX_BINDING_MISMATCH", "Semantic verdict is stale or bound to another review/run/result bundle.");
    await this.store.append(reviewId, OWNER, "web_verdict", { verdict: authority.value }, `semantic-${contentDigest(result.output)}`);
    return authority.value;
  }

  async getConnectionStatus(): Promise<BridgeConnectionStatus> {
    try { await (await this.client()).checkAvailability(); return { configured: true, connected: true, account: "ChatGPT via bundled Codex" }; }
    catch { return { configured: true, connected: false }; }
  }
}
