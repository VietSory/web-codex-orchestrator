import crypto from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
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
import { packagePhase4ResultForRun } from "./phase4-result.js";
import { attestRevisionAuthorityForOrchestration, reviseRunForOrchestration } from "./revise.js";
import { computeRetryDelay, retryableFailureCode } from "./retry-policy.js";

export type AutopilotJobStatus = "RUNNING" | "WAITING_WEB" | "WAITING_RETRY" | "PAUSED" | "READY_FOR_YOU" | "NEEDS_YOU";
export type AutopilotTerminalAction = "ASK_USER_TO_MERGE" | "ASK_USER_TO_INTERVENE" | null;
export type AutopilotStage = "EXECUTE" | "PUBLISH" | "DRAFT_PR" | "PACKAGE_RESULT" | "WAIT_WEB" | "REVISE" | "DONE";

type ActiveAutopilotStage = Exclude<AutopilotStage, "DONE">;
const ACTIVE_STAGES: ActiveAutopilotStage[] = ["EXECUTE", "PUBLISH", "DRAFT_PR", "PACKAGE_RESULT", "WAIT_WEB", "REVISE"];
const STAGES: AutopilotStage[] = [...ACTIVE_STAGES, "DONE"];
const STATUSES: AutopilotJobStatus[] = ["RUNNING", "WAITING_WEB", "WAITING_RETRY", "PAUSED", "READY_FOR_YOU", "NEEDS_YOU"];
const TERMINAL_ACTIONS: Exclude<AutopilotTerminalAction, null>[] = ["ASK_USER_TO_MERGE", "ASK_USER_TO_INTERVENE"];
const MAX_RETRY_ATTEMPTS = 5;

export interface AutopilotJobReceipt {
  schema_version: "2.0";
  mode: "AUTOPILOT";
  run_id: string;
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
  attestRevision(options: { runId: string; stateDirectory: string }): Promise<{ revisionRound: number }>;
  revise(options: { runId: string; revisionRound: number; stateDirectory: string; configPath: string; signal?: AbortSignal; now?: () => Date }): Promise<RevisionReceipt>;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

async function executeProduction(options: { runId: string; stateDirectory: string; configPath: string; signal?: AbortSignal }): Promise<ExecutionReceipt> {
  const config = await loadExecutionConfig(options.configPath);
  const runtime = await resolveCodexRuntime(config.runtime, options.stateDirectory);
  return await executeRun({
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    config,
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

function boundedCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validReceipt(value: unknown, runId: string): value is AutopilotJobReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<AutopilotJobReceipt>;
  if (receipt.schema_version !== "2.0" || receipt.mode !== "AUTOPILOT" || receipt.run_id !== runId) return false;
  if (typeof receipt.stage !== "string" || !STAGES.includes(receipt.stage as AutopilotStage)) return false;
  if (typeof receipt.status !== "string" || !STATUSES.includes(receipt.status as AutopilotJobStatus)) return false;
  if (!receipt.stage_attempts || typeof receipt.stage_attempts !== "object") return false;
  const attemptKeys = Object.keys(receipt.stage_attempts);
  if (attemptKeys.length !== ACTIVE_STAGES.length || !ACTIVE_STAGES.every((stage) => boundedCounter(receipt.stage_attempts?.[stage]))) return false;
  if (receipt.next_retry_at !== null && !validTimestamp(receipt.next_retry_at)) return false;
  if (receipt.pending_review_job_id !== null && (typeof receipt.pending_review_job_id !== "string" || receipt.pending_review_job_id.length === 0 || receipt.pending_review_job_id.length > 4096)) return false;
  if (!boundedCounter(receipt.web_review_rounds) || !boundedCounter(receipt.revision_rounds_completed)) return false;
  if (receipt.terminal_action !== null && (typeof receipt.terminal_action !== "string" || !TERMINAL_ACTIONS.includes(receipt.terminal_action as Exclude<AutopilotTerminalAction, null>))) return false;
  if (receipt.reason !== null && (typeof receipt.reason !== "string" || receipt.reason.length > 8_192)) return false;
  return validTimestamp(receipt.created_at) && validTimestamp(receipt.updated_at);
}

export async function readAutopilotReceipt(stateDirectory: string, runId: string): Promise<AutopilotJobReceipt | null> {
  const receiptPath = autopilotReceiptPath(stateDirectory, runId);
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt is not a bounded regular file.");
    const parsed: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    if (!validReceipt(parsed, runId)) throw new Error("AUTOPILOT_RECEIPT_INVALID: durable receipt does not match the requested run or schema.");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function persist(stateDirectory: string, receipt: AutopilotJobReceipt, now: () => Date): Promise<void> {
  receipt.updated_at = now().toISOString();
  await atomicWriteJson(autopilotReceiptPath(stateDirectory, receipt.run_id), receipt);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return "AUTOPILOT_OPERATIONAL_ERROR";
}
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 8_192); }
function retryIdentity(runId: string, stage: AutopilotStage): string { return crypto.createHash("sha256").update(`AUTOPILOT:${runId}:${stage}`).digest("hex"); }

async function retryOrStop(options: {
  receipt: AutopilotJobReceipt;
  stateDirectory: string;
  stage: ActiveAutopilotStage;
  error: unknown;
  now: () => Date;
  deps: AutopilotDependencies;
  signal?: AbortSignal;
}): Promise<boolean> {
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

async function honorPersistedRetryDeadline(options: {
  receipt: AutopilotJobReceipt;
  stateDirectory: string;
  now: () => Date;
  deps: AutopilotDependencies;
  signal?: AbortSignal;
}): Promise<boolean> {
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
  return { status: "NEEDS_YOU", reason: latest ? `${latest.code}: ${latest.message}` : `Execution stopped in ${execution.state}.` };
}

export async function driveAutopilotJob(options: {
  bridge: WebBridge;
  runId: string;
  stateDirectory: string;
  configPath: string;
  maxCycles?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
  dependencies?: Partial<AutopilotDependencies>;
}): Promise<AutopilotJobReceipt> {
  const deps = { ...productionDependencies, ...options.dependencies };
  const now = options.now ?? (() => new Date());
  const maxCycles = Math.max(1, Math.min(options.maxCycles ?? 32, 128));
  const pollIntervalMs = Math.max(250, Math.min(options.pollIntervalMs ?? 1_000, 10_000));
  let receipt = await readAutopilotReceipt(options.stateDirectory, options.runId) ?? initialReceipt(options.runId, now);
  await persist(options.stateDirectory, receipt, now);
  if (receipt.status === "READY_FOR_YOU" || receipt.status === "NEEDS_YOU") return receipt;
  if (!await honorPersistedRetryDeadline({ receipt, stateDirectory: options.stateDirectory, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) return receipt;

  let cycles = 0;
  while (true) {
    if (options.signal?.aborted) {
      receipt.status = "PAUSED";
      receipt.reason = "AUTOPILOT was interrupted and can resume from durable service checkpoints.";
      await persist(options.stateDirectory, receipt, now);
      return receipt;
    }
    if (receipt.stage === "DONE") return receipt;
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
      try {
        execution = await deps.execute({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "EXECUTE", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue;
        return receipt;
      }
      const boundary = executionBoundary(execution);
      if (boundary) {
        receipt.next_retry_at = null;
        receipt.status = boundary.status;
        receipt.terminal_action = boundary.status === "NEEDS_YOU" ? "ASK_USER_TO_INTERVENE" : null;
        receipt.reason = boundary.reason;
        await persist(options.stateDirectory, receipt, now);
        return receipt;
      }
      receipt.next_retry_at = null;
      receipt.stage = "PUBLISH";
      receipt.stage_attempts.EXECUTE = 0;
      receipt.reason = null;
      cycles += 1;
      await persist(options.stateDirectory, receipt, now);
      continue;
    }

    if (receipt.stage === "PUBLISH") {
      try {
        const published = await deps.publish({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
        if (published.state !== "PUSHED" || !published.commit_sha || published.remote_branch_sha !== published.commit_sha) throw Object.assign(new Error("Phase 5A did not reach exact PUSHED state."), { code: "AUTOPILOT_PUBLISH_INCOMPLETE" });
      } catch (error) {
        if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "PUBLISH", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue;
        return receipt;
      }
      receipt.next_retry_at = null;
      receipt.stage = "DRAFT_PR";
      receipt.stage_attempts.PUBLISH = 0;
      cycles += 1;
      await persist(options.stateDirectory, receipt, now);
      continue;
    }

    if (receipt.stage === "DRAFT_PR") {
      try {
        const draft = await deps.draft({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
        if (draft.state !== "OPEN" || draft.observed_draft !== true || draft.observed_state !== "open" || draft.pull_number === null) throw Object.assign(new Error("Phase 5B did not attest an exact open Draft PR."), { code: "AUTOPILOT_DRAFT_PR_INCOMPLETE" });
      } catch (error) {
        if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "DRAFT_PR", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue;
        return receipt;
      }
      receipt.next_retry_at = null;
      receipt.stage = "PACKAGE_RESULT";
      receipt.stage_attempts.DRAFT_PR = 0;
      cycles += 1;
      await persist(options.stateDirectory, receipt, now);
      continue;
    }

    if (receipt.stage === "PACKAGE_RESULT") {
      try {
        const result = await deps.packageResult({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
        if (result.state !== "READY_FOR_WEB_REVIEW" || !result.archive_sha256) throw Object.assign(new Error("Phase 6 Result Bundle is not ready for Web review."), { code: "AUTOPILOT_RESULT_INCOMPLETE" });
      } catch (error) {
        if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "PACKAGE_RESULT", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue;
        return receipt;
      }
      receipt.next_retry_at = null;
      receipt.stage = "WAIT_WEB";
      receipt.stage_attempts.PACKAGE_RESULT = 0;
      cycles += 1;
      await persist(options.stateDirectory, receipt, now);
      continue;
    }

    if (receipt.stage === "WAIT_WEB") {
      try {
        if (!receipt.pending_review_job_id) {
          const review = await deps.createFinalReview({ bridge: options.bridge, runId: options.runId, stateDirectory: options.stateDirectory });
          receipt.pending_review_job_id = review.job_id;
          receipt.status = "WAITING_WEB";
          receipt.reason = "Waiting for Web final review of the exact Result Bundle.";
          await persist(options.stateDirectory, receipt, now);
        }
        const envelope = await options.bridge.waitForVerdict(receipt.pending_review_job_id, options.signal);
        if (!envelope) {
          await deps.sleep(pollIntervalMs, options.signal);
          continue;
        }
        const adopted = await deps.materializeVerdict({ envelope, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.now ? { now: options.now } : {}) });
        receipt.next_retry_at = null;
        receipt.pending_review_job_id = null;
        receipt.web_review_rounds += 1;
        receipt.stage_attempts.WAIT_WEB = 0;
        cycles += 1;
        if (adopted.receipt.state === "APPROVED") {
          receipt.stage = "DONE";
          receipt.status = "READY_FOR_YOU";
          receipt.terminal_action = "ASK_USER_TO_MERGE";
          receipt.reason = "The exact Draft PR head passed Web final review. Merge remains human-owned.";
          await persist(options.stateDirectory, receipt, now);
          return receipt;
        }
        if (adopted.receipt.state === "REVISION_REQUESTED") {
          receipt.stage = "REVISE";
          receipt.status = "RUNNING";
          receipt.reason = null;
          await persist(options.stateDirectory, receipt, now);
          continue;
        }
        receipt.status = "NEEDS_YOU";
        receipt.terminal_action = "ASK_USER_TO_INTERVENE";
        receipt.reason = adopted.receipt.state === "ESCALATED" ? "Web final review escalated a consequential decision." : `Web review stopped in ${adopted.receipt.state}.`;
        await persist(options.stateDirectory, receipt, now);
        return receipt;
      } catch (error) {
        if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "WAIT_WEB", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue;
        return receipt;
      }
    }

    if (receipt.stage === "REVISE") {
      try {
        const authority = await deps.attestRevision({ runId: options.runId, stateDirectory: options.stateDirectory });
        const revised = await deps.revise({ runId: options.runId, revisionRound: authority.revisionRound, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(options.signal ? { signal: options.signal } : {}), ...(options.now ? { now: options.now } : {}) });
        if (revised.state !== "RESULT_READY" || !revised.result_bundle_sha256 || revised.remote_branch_sha !== revised.new_published_commit_sha) throw Object.assign(new Error("Phase 8 revision did not produce an exact reviewed Result Bundle."), { code: "AUTOPILOT_REVISION_INCOMPLETE" });
        receipt.revision_rounds_completed += 1;
      } catch (error) {
        if (await retryOrStop({ receipt, stateDirectory: options.stateDirectory, stage: "REVISE", error, now, deps, ...(options.signal ? { signal: options.signal } : {}) })) continue;
        return receipt;
      }
      receipt.next_retry_at = null;
      receipt.stage = "WAIT_WEB";
      receipt.stage_attempts.REVISE = 0;
      receipt.status = "RUNNING";
      receipt.reason = null;
      cycles += 1;
      await persist(options.stateDirectory, receipt, now);
    }
  }
}
