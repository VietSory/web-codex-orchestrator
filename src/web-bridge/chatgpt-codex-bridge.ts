import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import type { TrustedConfig } from "../config/contracts.js";
import { readPreparationForExecution } from "../execution/execution-store.js";
import { ensureChatGptLogin } from "../runtime/chatgpt-login.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { parseChatGptCodexAuthority } from "./chatgpt-codex-authority.js";
import { ChatGptCodexImplementationClient } from "./chatgpt-codex-implementation-client.js";
import { chatGptCodexAuthorPrompt, chatGptCodexRepositoryResultPrompt, chatGptCodexReviewPrompt } from "./chatgpt-codex-prompts.js";
import { ChatGptCodexSemanticClient } from "./chatgpt-codex-semantic-client.js";
import { WebBridgeError, contentDigest, parseWebContractEnvelope, parseWebImplementationSubmission, parseWebVerdictEnvelope, type AuthoringEvent, type BridgeConnectionStatus, type BridgeJobIdentity, type FinalReviewRequest, type RepositoryCommandResult, type WebContractEnvelope, type WebImplementationSubmission, type WebVerdictEnvelope } from "./contracts.js";
import type { PreparedRunAwareWebBridge } from "./prepared-run-aware.js";
import { RelayFileStore } from "./relay/file-store.js";
import { toAuthoringEvent } from "./relay/protocol.js";
import type { AuthoringJobRequest, WebBridge } from "./web-bridge.js";

const OWNER = "local-chatgpt-codex";
export const CHATGPT_CODEX_AUTH_REQUIRED_ACCOUNT = "ChatGPT authorization required";

type RelayEvents = Awaited<ReturnType<RelayFileStore["events"]>>;

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

function hasUnresolvedReservation(events: RelayEvents, reservationType: string, completionTypes: readonly string[]): boolean {
  const reservation = events.slice().reverse().find((event) => event.type === reservationType);
  if (!reservation) return false;
  return !events.some((event) => event.sequence > reservation.sequence && completionTypes.includes(event.type));
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

export class ChatGptCodexWebBridge implements WebBridge, PreparedRunAwareWebBridge {
  private readonly store: RelayFileStore;
  private readonly stateDirectory: string;
  private readonly scratchDirectory: string;
  private readonly authorityDirectory: string;
  private semantic: ChatGptCodexSemanticClient | null = null;
  private implementation: ChatGptCodexImplementationClient | null = null;

  constructor(private readonly config: TrustedConfig, bridgeDirectory: string) {
    this.store = new RelayFileStore(path.join(bridgeDirectory, "chatgpt-codex"));
    this.stateDirectory = path.dirname(path.resolve(bridgeDirectory));
    this.scratchDirectory = path.join(bridgeDirectory, "chatgpt-codex-runtime", "scratch");
    this.authorityDirectory = path.join(bridgeDirectory, "chatgpt-codex-runtime", "authority");
  }

  private async rawAgent(): Promise<CodexSdkAgentClient> {
    const runtime = await resolveCodexRuntime(this.config.runtime, this.stateDirectory);
    return new CodexSdkAgentClient(runtime);
  }

  private async client(): Promise<ChatGptCodexSemanticClient> {
    if (this.semantic) return this.semantic;
    this.semantic = new ChatGptCodexSemanticClient(await this.rawAgent());
    return this.semantic;
  }

  private async implementationClient(): Promise<ChatGptCodexImplementationClient> {
    if (this.implementation) return this.implementation;
    this.implementation = new ChatGptCodexImplementationClient(await this.rawAgent());
    return this.implementation;
  }

  private async ensureAuthorizedForProviderTurn(): Promise<void> {
    const authorized = await ensureChatGptLogin({ config: this.config, stateDirectory: this.stateDirectory });
    if (!authorized) {
      throw new WebBridgeError("CODEX_AUTH_UNAVAILABLE", "ChatGPT authorization is required. Run `wco web connect` in an interactive terminal.");
    }
  }

  private async turn(
    prompt: string,
    existingThreadId?: string,
    signal?: AbortSignal,
    reserve?: () => Promise<void>,
  ): Promise<{ thread_id: string; output: unknown }> {
    // All deterministic/local preflight must complete before the durable
    // at-most-once reservation. Once reserved, the next call is the provider
    // boundary and a crash/failure is intentionally treated as ambiguous.
    await this.ensureAuthorizedForProviderTurn();
    await mkdir(this.scratchDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.authorityDirectory, { recursive: true, mode: 0o700 });
    const profile = this.config.agents?.final_reviewer;
    if (!profile) throw new WebBridgeError("WEB_CHATGPT_CODEX_CONFIG_INVALID", "Semantic reviewer profile is missing.");
    const client = await this.client();
    if (reserve) await reserve();
    return await client.turn({ profile, prompt, scratchDirectory: this.scratchDirectory, authorityDirectory: this.authorityDirectory, ...(existingThreadId ? { threadId: existingThreadId } : {}), ...(signal ? { signal } : {}) });
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
    if (hasUnresolvedReservation(record.events, "chatgpt_codex_authoring_reserved", ["repository_command", "contract_sealed"])) {
      throw new WebBridgeError("WEB_CHATGPT_CODEX_AMBIGUOUS_AUTHORING", "A prior semantic author turn may have completed without durable authority; WCO refuses to replay an ambiguous contract/repository decision.");
    }
    const lastAuthority = record.events.slice().reverse().find((event) => ["repository_command", "contract_sealed"].includes(event.type));
    const latestResult = record.events.slice().reverse().find((event) => event.type === "repository_command_result" && (!lastAuthority || event.sequence > lastAuthority.sequence));
    const latestClarification = record.events.slice().reverse().find((event) => event.type === "user_clarification" && (!lastAuthority || event.sequence > lastAuthority.sequence));
    if (lastAuthority?.type === "repository_command" && !latestResult && !latestClarification) return null;
    const request = record.request as AuthoringJobRequest;
    const prompt = latestResult ? chatGptCodexRepositoryResultPrompt(latestResult.payload) : latestClarification ? `${chatGptCodexAuthorPrompt(request)}\nUser clarification: ${JSON.stringify(latestClarification.payload)}` : chatGptCodexAuthorPrompt(request);
    const existingThread = threadId(record.events);
    const inputSha256 = contentDigest({ prompt, thread_id: existingThread ?? null });
    const result = await this.turn(
      prompt,
      existingThread,
      signal,
      async () => {
        await this.store.append(jobId, OWNER, "chatgpt_codex_authoring_reserved", { input_sha256: inputSha256, thread_id: existingThread ?? null }, `author-reserve-${inputSha256}`);
      },
    );
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
    const reservation = record.events.slice().reverse().find((event) => event.type === "chatgpt_codex_implementation_reserved");
    if (reservation) throw new WebBridgeError("WEB_CHATGPT_CODEX_AMBIGUOUS_IMPLEMENTATION", "A prior implementation provider turn may have started without a durable result; WCO refuses to replay an ambiguous mutation proposal.");

    // Auth, exact preparation identity, profile and client construction are all
    // deterministic preflight. Do them before reserving the at-most-once model
    // boundary so a recoverable auth/config failure cannot poison the job.
    await this.ensureAuthorizedForProviderTurn();
    const preparation = await readPreparationForExecution(this.stateDirectory, runId);
    const profile = this.config.agents?.implementer;
    if (!profile) throw new WebBridgeError("WEB_CHATGPT_CODEX_CONFIG_INVALID", "Harness implementer profile is missing.");
    const client = await this.implementationClient();
    await this.store.append(jobId, OWNER, "chatgpt_codex_implementation_reserved", { run_id: runId }, `implementation-reserve-${contentDigest({ jobId, runId })}`);
    const submission = await client.propose({
      profile,
      jobId,
      runId,
      workspacePath: preparation.receipt.worktree_path,
      acceptedBundlePath: preparation.receipt.accepted_bundle_path,
    });
    await this.store.append(jobId, OWNER, "implementation_sealed", { submission }, `implementation-${contentDigest(submission)}`);
    return submission;
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
    if (existing) {
      if (existing !== runId) throw new WebBridgeError("WEB_CHATGPT_CODEX_BINDING_MISMATCH", "Authoring job is already bound to a different canonical prepared run.");
      return;
    }
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
    if (hasUnresolvedReservation(record.events, "chatgpt_codex_review_reserved", ["web_verdict"])) {
      throw new WebBridgeError("WEB_CHATGPT_CODEX_AMBIGUOUS_REVIEW", "A prior semantic review turn may have completed without a durable verdict; WCO refuses to replay an ambiguous authority-bearing review.");
    }
    const request = record.request as FinalReviewRequest;
    const prompt = chatGptCodexReviewPrompt(request, evidence.payload as Record<string, unknown>);
    const inputSha256 = contentDigest({ reviewId, prompt });
    const result = await this.turn(
      prompt,
      undefined,
      signal,
      async () => {
        await this.store.append(reviewId, OWNER, "chatgpt_codex_review_reserved", { input_sha256: inputSha256 }, `review-reserve-${inputSha256}`);
      },
    );
    await this.store.append(reviewId, OWNER, "chatgpt_codex_review_thread", { thread_id: result.thread_id }, `review-thread-${contentDigest({ reviewId, inputSha256, thread: result.thread_id })}`);
    const authority = parseChatGptCodexAuthority(result.output);
    if (authority.kind !== "web_verdict") throw new WebBridgeError("WEB_CHATGPT_CODEX_PHASE_INVALID", "Final review must return a Web verdict.");
    if (authority.value.review_id !== reviewId || authority.value.run_id !== request.run_id || authority.value.result_bundle_sha256 !== request.result_bundle_sha256) throw new WebBridgeError("WEB_CHATGPT_CODEX_BINDING_MISMATCH", "Semantic verdict is stale or bound to another review/run/result bundle.");
    await this.store.append(reviewId, OWNER, "web_verdict", { verdict: authority.value }, `semantic-${contentDigest(result.output)}`);
    return authority.value;
  }

  async getConnectionStatus(): Promise<BridgeConnectionStatus> {
    try {
      await (await this.client()).checkAvailability();
      return { configured: true, connected: true, account: "ChatGPT via bundled Codex" };
    } catch (error) {
      if (errorCode(error) === "CODEX_AUTH_UNAVAILABLE") {
        // `connected` here means the local bridge/runtime is reachable. The
        // account sentinel lets status surfaces remain truthful while TUI
        // routing never falls through to an unrelated compatibility setup.
        return { configured: true, connected: true, account: CHATGPT_CODEX_AUTH_REQUIRED_ACCOUNT };
      }
      return { configured: true, connected: false };
    }
  }
}
