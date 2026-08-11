import crypto from "node:crypto";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { readReviewMode } from "../agent/reviewer-mode-store.js";
import { redact } from "../evidence/log-redaction.js";
import { loadExecutionConfig } from "../execution/execution-config.js";
import { executeRun } from "../execution/execution-service.js";
import type { ExecutionReceipt } from "../execution/contracts.js";
import { createDraftPullRequestForRun } from "../pull-request/phase5b-service.js";
import type { DraftPullRequestReceipt } from "../pull-request/contracts.js";
import { publishPhase4Run } from "../publish/phase4-publish-service.js";
import type { GitPublishReceipt } from "../publish/contracts.js";
import type { ResultBundleReceipt } from "../result-bundle/contracts.js";
import type { RevisionReceipt } from "../revision/contracts.js";
import { atomicWriteJson, runDirectory } from "../run/run-store.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { CodexVerificationSandbox } from "../verifier/codex-sandbox.js";
import { createPendingFinalReview } from "../web-bridge/final-review-service.js";
import { materializeAndSubmitWebVerdict } from "../web-bridge/verdict-materializer.js";
import type { WebBridge } from "../web-bridge/web-bridge.js";
import type { WebReviewReceipt } from "../web-review/contracts.js";
import { revalidateAutopilotReadyForMerge } from "./autopilot-ready-attestation.js";
import { readStableAutopilotBytes } from "./autopilot-state.js";
import { packagePhase4ResultForRun } from "./phase4-result.js";
import { attestRevisionAuthorityForOrchestration, reviseRunForOrchestration } from "./revise.js";
import { computeRetryDelay, retryableFailureCode } from "./retry-policy.js";
import { withRunLock } from "./run-lock.js";

export type AutopilotJobStatus = "RUNNING" | "WAITING_WEB" | "WAITING_RETRY" | "PAUSED" | "READY_FOR_YOU" | "NEEDS_YOU";
export type AutopilotTerminalAction = "ASK_USER_TO_MERGE" | "ASK_USER_TO_INTERVENE" | null;
export type AutopilotStage = "EXECUTE" | "PUBLISH" | "DRAFT_PR" | "PACKAGE_RESULT" | "WAIT_WEB" | "REVISE" | "DONE";

type ActiveAutopilotStage = Exclude<AutopilotStage, "DONE">;
const ACTIVE_STAGES: ActiveAutopilotStage[] = ["EXECUTE", "PUBLISH", "DRAFT_PR", "PACKAGE_RESULT", "WAIT_WEB", "REVISE"];
const STAGES: AutopilotStage[] = [...ACTIVE_STAGES, "DONE"];
const STATUSES: AutopilotJobStatus[] = ["RUNNING", "WAITING_WEB", "WAITING_RETRY", "PAUSED", "READY_FOR_YOU", "NEEDS_YOU"];
const TERMINAL_ACTIONS: Exclude<AutopilotTerminalAction, null>[] = ["ASK_USER_TO_MERGE", "ASK_USER_TO_INTERVENE"];
const MAX_RETRY_ATTEMPTS = 5;
const MAX_GENERATION = 1_000_000;

export interface AutopilotJobReceipt {
  schema_version: "2.0";
  mode: "AUTOPILOT";
  run_id: string;
  generation: number;
  status: AutopilotJobStatus;
  stage: AutopilotStage;
  stage_attempts: Record<ActiveAutopilotStage, number>;
  next_retry_at: string | null;
  pending_review_job_id: string | null;
  web_review_rounds: number;
  revision_rounds_completed: number;
  terminal_action: AutopilotTerminalAction;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutopilotDependencies {
  execute(options: { runId: string; stateDirectory: string; configPath: string; signal?: AbortSignal }): Promise<ExecutionReceipt>;
  publish(options: { runId: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<GitPublishReceipt>;
  draft(options: { runId: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<DraftPullRequestReceipt>;
  packageResult(options: { runId: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<ResultBundleReceipt>;
  createFinalReview(options: { bridge: WebBridge; runId: string; stateDirectory: string }): Promise<{ job_id: string }>;
  materializeVerdict(options: { envelope: unknown; stateDirectory: string; configPath: string; now?: () => Date }): Promise<{ verdict_path: string; receipt: WebReviewReceipt }>;
  revalidateReady(options: { runId: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<WebReviewReceipt>;
  attestRevision(options: { runId: string; stateDirectory: string }): Promise<{ revisionRound: number }>;
  revise(options: { runId: string; revisionRound: number; stateDirectory: string; configPath: string; signal?: AbortSignal; now?: () => Date }): Promise<RevisionReceipt>;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

async function executeProduction(options: { runId: string; stateDirectory: string; configPath: string; signal?: AbortSignal }): Promise<ExecutionReceipt> {
  const [config, reviewerSelection] = await Promise.all([
    loadExecutionConfig(options.configPath),
    readReviewMode(options.stateDirectory),
  ]);
  const runtime = await resolveCodexRuntime(config.runtime, options.stateDirectory);
  return await executeRun({
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    config,
    reviewerSelection,
    agentClient: new CodexSdkAgentClient(runtime),
    sandbox: new CodexVerificationSandbox(runtime),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

const productionDependencies: AutopilotDependencies = {
  execute: executeProduction,
  publish: publishPhase4Run,
  draft: createDraftPullRequestForRun,
  packageResult: packagePhase4ResultForRun,
  createFinalReview: createPendingFinalReview,
  materializeVerdict: materializeAndSubmitWebVerdict,
  revalidateReady: revalidateAutopilotReadyForMerge,
  attestRevision: attestRevisionAuthorityForOrchestration,
  revise: reviseRunForOrchestration,
  sleep: async (milliseconds, signal) => {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      timer = setTimeout(finish, milliseconds);
      signal?.addEventListener("abort", finish, { once: true });
    });
  },
};

function splitRunId(runId: string): { taskId: string; archiveSha: string } {
  const index = runId.lastIndexOf(":");
  const taskId = runId.slice(0, index);
  const archiveSha = runId.slice(index + 1);
  if (index < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(archiveSha)) throw new Error("AUTOPILOT_RUN_ID_INVALID: run identity is unsafe.");
  return { taskId, archiveSha };
}

export function autopilotReceiptPath(stateDirectory: string, runId: string): string {
  const identity = splitRunId(runId);
  return path.join(runDirectory(stateDirectory, identity.taskId, identity.archiveSha), "autopilot.json");
}

function emptyAttempts(): AutopilotJobReceipt["stage_attempts"] {
  return { EXECUTE: 0, PUBLISH: 0, DRAFT_PR: 0, PACKAGE_RESULT: 0, WAIT_WEB: 0, REVISE: 0 };
}

function initialReceipt(runId: string, now: () => Date): AutopilotJobReceipt {
  const timestamp = now().toISOString();
  return {
    schema_version: "2.0",
    mode: "AUTOPILOT",
    run_id: runId,
    generation: 0,
    status: "RUNNING",
    stage: "EXECUTE",
    stage_attempts: emptyAttempts(),
    next_retry_at: null,
    pending_review_job_id: null,
    web_review_rounds: 0,
    revision_rounds_completed: 0,
    terminal_action: null,
    reason: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function boundedCounter(value: unknown, maximum = 10_000): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function semanticReceiptValid(receipt: AutopilotJobReceipt): boolean {
  if (Date.parse(receipt.updated_at) < Date.parse(receipt.created_at)) return false;
  if (receipt.revision_rounds_completed > 3 || receipt.web_review_rounds > 4 || receipt.revision_rounds_completed > receipt.web_review_rounds) return false;
  if (ACTIVE_STAGES.some((stage) => receipt.stage_attempts[stage] > MAX_RETRY_ATTEMPTS + 1)) return false;
  if (receipt.pending_review_job_id !== null && receipt.stage !== "WAIT_WEB") return false;
  if (receipt.next_retry_at !== null && receipt.status !== "WAITING_RETRY" && receipt.status !== "PAUSED") return false;
  if (receipt.stage === "DONE" && receipt.status !== "READY_FOR_YOU") return false;
  if (receipt.status === "READY_FOR_YOU") return receipt.stage === "DONE" && receipt.terminal_action === "ASK_USER_TO_MERGE" && receipt.pending_review_job_id === null && receipt.next_retry_at === null;
  if (receipt.terminal_action === "ASK_USER_TO_MERGE") return false;
  if (receipt.status === "NEEDS_YOU") return receipt.terminal_action === "ASK_USER_TO_INTERVENE" && receipt.next_retry_at === null && receipt.stage !== "DONE";
  if (receipt.terminal_action !== null) return false;
  if (receipt.status === "WAITING_WEB") return receipt.stage === "WAIT_WEB" && receipt.pending_review_job_id !== null && receipt.next_retry_at === null;
  if (receipt.status === "WAITING_RETRY") return receipt.stage !== "DONE" && receipt.next_retry_at !== null;
  if (receipt.status === "PAUSED") return receipt.stage !== "DONE";
  return receipt.status === "RUNNING" && receipt.stage !== "DONE" && receipt.next_retry_at === null;
}

function validReceipt(value: unknown, runId: string): value is AutopilotJobReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<AutopilotJobReceipt>;
  if (receipt.schema_version !== "2.0" || receipt.mode !== "AUTOPILOT" || receipt.run_id !== runId) return false;
  if (!boundedCounter(receipt.generation, MAX_GENERATION)) return false;
  if (typeof receipt.stage !== "string" || !STAGES.includes(receipt.stage as AutopilotStage)) return false;
  if (typeof receipt.status !== "string" || !STATUSES.includes(receipt.status as AutopilotJobStatus)) return false;
  if (!receipt.stage_attempts || typeof receipt.stage_attempts !== "object" || Array.isArray(receipt.stage_attempts)) return false;
  const attemptKeys = Object.keys(receipt.stage_attempts);
  if (attemptKeys.length !== ACTIVE_STAGES.length || !ACTIVE_STAGES.every((stage) => boundedCounter(receipt.stage_attempts?.[stage], MAX_RETRY_ATTEMPTS + 1))) return false;
  if (receipt.next_retry_at !== null && !validTimestamp(receipt.next_retry_at)) return false;
  if (receipt.pending_review_job_id !== null && (typeof receipt.pending_review_job_id !== "string" || receipt.pending_review_job_id.length === 0 || receipt.pending_review_job_id.length > 4096)) return false;
  if (!boundedCounter(receipt.web_review_rounds, 4) || !boundedCounter(receipt.revision_rounds_completed, 3)) return false;
  if (receipt.terminal_action !== null && (typeof receipt.terminal_action !== "string" || !TERMINAL_ACTIONS.includes(receipt.terminal_action as Exclude<AutopilotTerminalAction, null>))) return false;
  if (receipt.reason !== null && (typeof receipt.reason !== "string" || receipt.reason.length > 8_192)) return false;
  if (!validTimestamp(receipt.created_at) || !validTimestamp(receipt.updated_at)) return false;
  return semanticReceiptValid(receipt as AutopilotJobReceipt);
}

function parseReceiptBytes(bytes: Buffer, runId: string): AutopilotJobReceipt {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("AUTOPILOT_RECEIPT_INVALID: durable receipt is not valid JSON."); }
  if (!validReceipt(parsed, runId)) throw new Error("AUTOPILOT_RECEIPT_INVALID: durable receipt does not match the requested run or semantic state invariants.");
  return parsed;
}

export async function readAutopilotReceipt(stateDirectory: string, runId: string): Promise<AutopilotJobReceipt | null> {
  const bytes = await readStableAutopilotBytes(autopilotReceiptPath(stateDirectory, runId));
  return bytes ? parseReceiptBytes(bytes, runId) : null;
}

async function persist(stateDirectory: string, receipt: AutopilotJobReceipt, now: () => Date): Promise<void> {
  await withRunLock(stateDirectory, receipt.run_id, async () => {
    const receiptPath = autopilotReceiptPath(stateDirectory, receipt.run_id);
    const currentBytes = await readStableAutopilotBytes(receiptPath);
    if (currentBytes) {
      const current = parseReceiptBytes(currentBytes, receipt.run_id);
      if (current.generation !== receipt.generation) throw Object.assign(new Error("AUTOPILOT_CONCURRENT_DRIVER: durable state advanced in another process; refusing to overwrite newer authority."), { code: "AUTOPILOT_CONCURRENT_DRIVER" });
    } else if (receipt.generation !== 0) {
      throw Object.assign(new Error("AUTOPILOT_CONCURRENT_DRIVER: durable receipt disappeared after this driver observed it."), { code: "AUTOPILOT_CONCURRENT_DRIVER" });
    }
    if (receipt.generation >= MAX_GENERATION) throw new Error("AUTOPILOT_RECEIPT_INVALID: generation budget exhausted.");
    const next: AutopilotJobReceipt = { ...receipt, stage_attempts: { ...receipt.stage_attempts }, generation: receipt.generation + 1, updated_at: now().toISOString() };
    if (!validReceipt(next, receipt.run_id)) throw new Error("AUTOPILOT_RECEIPT_INVALID: refusing to persist an inconsistent durable state.");
    await atomicWriteJson(receiptPath, next);
    Object.assign(receipt, next);
    receipt.stage_attempts = next.stage_attempts;
  });
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return "AUTOPILOT_OPERATIONAL_ERROR";
}
function errorMessage(error: unknown): string { return redact(error instanceof Error ? error.message : String(error)).slice(0, 8_192); }
function retryIdentity(runId: string, stage: AutopilotStage): string { return crypto.createHash("sha256").update(`AUTOPILOT:${runId}:${stage}`).digest("hex"); }

function assertDraftReady(draft: DraftPullRequestReceipt): void {
  if (draft.state !== "OPEN" || draft.observed_draft !== true || draft.observed_state !== "open" || draft.pull_number === null || !draft.pull_url || !draft.observed_head_sha || draft.observed_head_sha !== draft.expected_head_sha || draft.observed_base_branch !== draft.base_branch) {
    throw Object.assign(new Error("Phase 5B did not attest an exact open Draft PR at the expected published head."), { code: "AUTOPILOT_DRAFT_PR_INCOMPLETE" });
  }
}

function assertResultReady(runId: string, result: ResultBundleReceipt): void {
  if (result.state !== "READY_FOR_WEB_REVIEW" || result.run_id !== runId || !result.archive_sha256 || !result.manifest_sha256 || !result.reviewed_entry_set_sha256 || !result.spec_set_sha256 || result.published_commit_sha !== result.remote_branch_sha || result.pull_request.state !== "open" || result.pull_request.draft !== true || result.pull_request.head_sha !== result.published_commit_sha || result.pull_request.number < 1) {
    throw Object.assign(new Error("Phase 6 Result Bundle is not an exact verified Draft-PR-bound handoff."), { code: "AUTOPILOT_RESULT_INCOMPLETE" });
  }
}

function assertApprovedReview(runId: string, review: WebReviewReceipt): void {
  if (review.run_id !== runId || review.state !== "APPROVED" || review.action !== "ASK_USER_TO_MERGE" || !review.verdict_sha256 || !review.decision_event_sha256 || !review.fresh_attested_head_sha || review.fresh_attested_head_sha !== review.published_commit_sha || review.observed_head_sha !== review.published_commit_sha || !review.completed_at) {
    throw Object.assign(new Error("Web approval is not bound to the exact freshly attested published Draft PR head."), { code: "AUTOPILOT_WEB_APPROVAL_INCOMPLETE" });
  }
}

async function retryOrStop(options: { receipt: AutopilotJobReceipt; stateDirectory: string; stage: ActiveAutopilotStage; error: unknown; now: () => Date; deps: AutopilotDependencies; signal?: AbortSignal }): Promise<boolean> {
  if (options.signal?.aborted) {
    options.receipt.status = "PAUSED";
    options.receipt.reason = "AUTOPILOT was interrupted and can resume from durable service checkpoints.";
    await persist(options.stateDirectory, options.receipt, options.now);
    return false;
  }
  const code = errorCode(options.error);
  const attempt = options.receipt.stage_attempts[options.stage] + 1;
  options.receipt.stage_attempts[options.stage] = attempt;
  if (retryableFailureCode(code) && attempt <= MAX_RETRY_ATTEMPTS) {
    const delay = computeRetryDelay(retryIdentity(options.receipt.run_id, options.stage), attempt);
    options.receipt.status = "WAITING_RETRY";
    options.receipt.next_retry_at = new Date(options.now().getTime() + delay).toISOString();
    options.receipt.reason = `${code}: ${errorMessage(options.error)}`;
    await persist(options.stateDirectory, options.receipt, options.now);
    await options.deps.sleep(delay, options.signal);
    if (options.signal?.aborted) {
      options.receipt.status = "PAUSED";
      options.receipt.reason = "AUTOPILOT was interrupted during retry backoff and will preserve the retry deadline on resume.";
      await persist(options.stateDirectory, options.receipt, options.now);
      return false;
    }
    options.receipt.next_retry_at = null;
    options.receipt.status = "RUNNING";
    options.receipt.reason = null;
    await persist(options.stateDirectory, options.receipt, options.now);
    return true;
  }
  options.receipt.next_retry_at = null;
  options.receipt.status = "NEEDS_YOU";
  options.receipt.terminal_action = "ASK_USER_TO_INTERVENE";
  options.receipt.reason = `${code}: ${errorMessage(options.error)}`;
  await persist(options.stateDirectory, options.receipt, options.now);
  return false;
}

async function honorPersistedRetryDeadline(options: { receipt: AutopilotJobReceipt; stateDirectory: string; now: () => Date; deps: AutopilotDependencies; signal?: AbortSignal }): Promise<boolean> {
  if (!options.receipt.next_retry_at) return true;
  const deadline = Date.parse(options.receipt.next_retry_at);
  if (!Number.isFinite(deadline)) throw new Error("AUTOPILOT_RECEIPT_INVALID: retry deadline is invalid.");
  const remaining = deadline - options.now().getTime();
  if (remaining > 0) {
    options.receipt.status = "WAITING_RETRY";
    await persist(options.stateDirectory, options.receipt, options.now);
    await options.deps.sleep(remaining, options.signal);
  }
  if (options.signal?.aborted) {
    options.receipt.status = "PAUSED";
    options.receipt.reason = "AUTOPILOT was interrupted while honoring a persisted retry deadline.";
    await persist(options.stateDirectory, options.receipt, options.now);
    return false;
  }
  options.receipt.next_retry_at = null;
  options.receipt.status = "RUNNING";
  options.receipt.reason = null;
  await persist(options.stateDirectory, options.receipt, options.now);
  return true;
}

function executionBoundary(execution: ExecutionReceipt): { status: AutopilotJobStatus; reason: string } | null {
  if (execution.state === "READY_FOR_PUBLISH") return null;
  if (execution.state === "INTERRUPTED") return { status: "PAUSED", reason: "Execution was interrupted and is resumable from the Phase 4 receipt." };
  const latest = execution.errors.at(-1);
  return { status: "NEEDS_YOU", reason: latest ? `${latest.code}: ${redact(latest.message).slice(0, 8_192)}` : `Execution stopped in ${execution.state}.` };
}

export async function driveAutopilotJob(options: {
  bridge: WebBridge;
  runId: string;
  stateDirectory: string;
  configPath: string;
  maxCycles?: number;
  pollIntervalMs?: number;
  /** Legacy/advanced compatibility. Normal `wco /auto` sets this false. */
  webFinalReview?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
  dependencies?: Partial<AutopilotDependencies>;
}): Promise<AutopilotJobReceipt> {
  const deps = { ...productionDependencies, ...options.dependencies };
  const now = options.now ?? (() => new Date());
  const maxCycles = Math.max(1, Math.min(options.maxCycles ?? 32, 128));
  const pollIntervalMs = Math.max(250, Math.min(options.pollIntervalMs ?? 1_000, 10_000));
  const webFinalReview = options.webFinalReview !== false;
  const existing = await readAutopilotReceipt(options.stateDirectory, options.runId);
  let receipt = existing ?? initialReceipt(options.runId, now);
  if (!existing) await persist(options.stateDirectory, receipt, now);

  if (receipt.status === "READY_FOR_YOU") {
    if (webFinalReview && receipt.web_review_rounds > 0) {
      const refreshed = await deps.revalidateReady({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
      assertApprovedReview(options.runId, refreshed);
    } else {
      const refreshed = await deps.packageResult({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
      assertResultReady(options.runId, refreshed);
    }
    return receipt;
  }
  if (receipt.status === "NEEDS_YOU") return receipt;
  if (!await honorPersistedRetryDeadline({ receipt, stateDirectory: options.stateDirectory, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) return receipt;

  let cycles = 0;
  while (true) {
    if (options.signal?.aborted) {
      receipt.status = "PAUSED";
      receipt.reason = "AUTOPILOT was interrupted and can resume from durable service checkpoints.";
      await persist(options.stateDirectory, receipt, now);
      return receipt;
    }
    if (receipt.stage === "DONE") throw new Error("AUTOPILOT_RECEIPT_INVALID: DONE stage must be terminal READY_FOR_YOU.");
    if (cycles >= maxCycles) {
      receipt.next_retry_at = null;
      receipt.status = "NEEDS_YOU";
      receipt.terminal_action = "ASK_USER_TO_INTERVENE";
      receipt.reason = `AUTOPILOT_CYCLE_BUDGET_EXHAUSTED: exceeded ${maxCycles} completed orchestration stages.`;
      await persist(options.stateDirectory, receipt, now);
      return receipt;
    }

    if (receipt.stage === "EXECUTE") {
      let execution: ExecutionReceipt;
      try { execution = await deps.execute({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.signal ? { signal: options.signal } : {}) }); }
      catch (error) { if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "EXECUTE", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue; return receipt; }
      const boundary = executionBoundary(execution);
      if (boundary) {
        receipt.next_retry_at = null;
        receipt.status = boundary.status;
        receipt.terminal_action = boundary.status === "NEEDS_YOU" ? "ASK_USER_TO_INTERVENE" : null;
        receipt.reason = boundary.reason;
        await persist(options.stateDirectory, receipt, now);
        return receipt;
      }
      receipt.next_retry_at = null; receipt.stage = "PUBLISH"; receipt.stage_attempts.EXECUTE = 0; receipt.reason = null; cycles += 1; await persist(options.stateDirectory, receipt, now); continue;
    }

    if (receipt.stage === "PUBLISH") {
      try {
        const published = await deps.publish({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
        if (published.state !== "PUSHED" || !published.commit_sha || published.remote_branch_sha !== published.commit_sha) throw Object.assign(new Error("Phase 5A did not reach exact PUSHED state."), { code: "AUTOPILOT_PUBLISH_INCOMPLETE" });
      } catch (error) { if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "PUBLISH", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue; return receipt; }
      receipt.next_retry_at = null; receipt.stage = "DRAFT_PR"; receipt.stage_attempts.PUBLISH = 0; cycles += 1; await persist(options.stateDirectory, receipt, now); continue;
    }

    if (receipt.stage === "DRAFT_PR") {
      try { const draft = await deps.draft({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) }); assertDraftReady(draft); }
      catch (error) { if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "DRAFT_PR", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue; return receipt; }
      receipt.next_retry_at = null; receipt.stage = "PACKAGE_RESULT"; receipt.stage_attempts.DRAFT_PR = 0; cycles += 1; await persist(options.stateDirectory, receipt, now); continue;
    }

    if (receipt.stage === "PACKAGE_RESULT") {
      try {
        const result = await deps.packageResult({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
        assertResultReady(options.runId, result);
      } catch (error) { if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "PACKAGE_RESULT", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue; return receipt; }
      receipt.next_retry_at = null;
      receipt.stage_attempts.PACKAGE_RESULT = 0;
      cycles += 1;
      if (!webFinalReview) {
        receipt.stage = "DONE";
        receipt.status = "READY_FOR_YOU";
        receipt.terminal_action = "ASK_USER_TO_MERGE";
        receipt.reason = "The exact Draft PR head passed deterministic verification and the selected model review. Merge remains human-owned and the Result Bundle/Draft PR authority is freshly re-attested on later READY reads.";
        await persist(options.stateDirectory, receipt, now);
        return receipt;
      }
      receipt.stage = "WAIT_WEB";
      await persist(options.stateDirectory, receipt, now);
      continue;
    }

    if (receipt.stage === "WAIT_WEB") {
      try {
        if (!receipt.pending_review_job_id) {
          const review = await deps.createFinalReview({ bridge: options.bridge, runId: options.runId, stateDirectory: options.stateDirectory });
          receipt.pending_review_job_id = review.job_id;
          receipt.status = "WAITING_WEB";
          receipt.reason = "Waiting for legacy Web final review of the exact Result Bundle.";
          await persist(options.stateDirectory, receipt, now);
        }
        const envelope = await options.bridge.waitForVerdict(receipt.pending_review_job_id, options.signal);
        if (!envelope) { await deps.sleep(pollIntervalMs, options.signal); continue; }
        const adopted = await deps.materializeVerdict({ envelope, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
        receipt.next_retry_at = null; receipt.pending_review_job_id = null; receipt.web_review_rounds += 1; receipt.stage_attempts.WAIT_WEB = 0; cycles += 1;
        if (adopted.receipt.state === "APPROVED") {
          assertApprovedReview(options.runId, adopted.receipt);
          receipt.stage = "DONE"; receipt.status = "READY_FOR_YOU"; receipt.terminal_action = "ASK_USER_TO_MERGE"; receipt.reason = "The exact Draft PR head passed legacy Web final review. Merge remains human-owned and is freshly re-attested on every later READY read.";
          await persist(options.stateDirectory, receipt, now); return receipt;
        }
        if (adopted.receipt.state === "REVISION_REQUESTED") { receipt.stage = "REVISE"; receipt.status = "RUNNING"; receipt.reason = null; await persist(options.stateDirectory, receipt, now); continue; }
        receipt.status = "NEEDS_YOU"; receipt.terminal_action = "ASK_USER_TO_INTERVENE"; receipt.reason = adopted.receipt.state === "ESCALATED" ? "Legacy Web final review escalated a consequential decision." : `Legacy Web review stopped in ${adopted.receipt.state}.`;
        await persist(options.stateDirectory, receipt, now); return receipt;
      } catch (error) { if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "WAIT_WEB", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue; return receipt; }
    }

    if (receipt.stage === "REVISE") {
      try {
        const authority = await deps.attestRevision({ runId: options.runId, stateDirectory: options.stateDirectory });
        const revised = await deps.revise({ runId: options.runId, revisionRound: authority.revisionRound, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.signal ? { signal: options.signal } : {}), ...(options.now ? { now: options.now } : {}) });
        if (revised.state !== "RESULT_READY" || !revised.result_bundle_sha256 || revised.remote_branch_sha !== revised.new_published_commit_sha) throw Object.assign(new Error("Phase 8 revision did not produce an exact reviewed Result Bundle."), { code: "AUTOPILOT_REVISION_INCOMPLETE" });
        receipt.revision_rounds_completed += 1;
      } catch (error) { if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "REVISE", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue; return receipt; }
      receipt.next_retry_at = null; receipt.stage = "WAIT_WEB"; receipt.stage_attempts.REVISE = 0; receipt.status = "RUNNING"; receipt.reason = null; cycles += 1; await persist(options.stateDirectory, receipt, now);
    }
  }
}
