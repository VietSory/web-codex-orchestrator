import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, runDirectory } from "../run/run-store.js";
import { createPendingFinalReview } from "../web-bridge/final-review-service.js";
import { materializeAndSubmitWebVerdict } from "../web-bridge/verdict-materializer.js";
import type { WebBridge } from "../web-bridge/web-bridge.js";
import { deriveNextTransition, type LifecycleSnapshot, type PlannedTransition } from "./planner.js";
import { readLifecycleSnapshot } from "./snapshot-reader.js";
import { runNextTransition, type ContinueResult } from "./transition-runner.js";

export type AutopilotJobStatus = "RUNNING" | "WAITING_WEB" | "WAITING_RETRY" | "PAUSED" | "READY_FOR_YOU" | "NEEDS_YOU";
export type AutopilotTerminalAction = "ASK_USER_TO_MERGE" | "ASK_USER_TO_INTERVENE" | null;

export interface AutopilotJobReceipt {
  schema_version: "1.0";
  mode: "AUTOPILOT";
  run_id: string;
  web_pack_path: string;
  status: AutopilotJobStatus;
  last_transition: string | null;
  pending_review_job_id: string | null;
  web_review_rounds: number;
  terminal_action: AutopilotTerminalAction;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutopilotDependencies {
  readSnapshot: typeof readLifecycleSnapshot;
  deriveNext: typeof deriveNextTransition;
  runNext: typeof runNextTransition;
  createFinalReview: typeof createPendingFinalReview;
  materializeVerdict: typeof materializeAndSubmitWebVerdict;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

const productionDependencies: AutopilotDependencies = {
  readSnapshot: readLifecycleSnapshot,
  deriveNext: deriveNextTransition,
  runNext: runNextTransition,
  createFinalReview: createPendingFinalReview,
  materializeVerdict: materializeAndSubmitWebVerdict,
  sleep: async (milliseconds, signal) => {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};

function splitRunId(runId: string): { taskId: string; archiveSha: string } {
  const index = runId.lastIndexOf(":");
  const taskId = runId.slice(0, index);
  const archiveSha = runId.slice(index + 1);
  if (index < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(archiveSha)) {
    throw new Error("AUTOPILOT_RUN_ID_INVALID: run identity is unsafe.");
  }
  return { taskId, archiveSha };
}

export function autopilotReceiptPath(stateDirectory: string, runId: string): string {
  const identity = splitRunId(runId);
  return path.join(runDirectory(stateDirectory, identity.taskId, identity.archiveSha), "autopilot.json");
}

export async function readAutopilotReceipt(stateDirectory: string, runId: string): Promise<AutopilotJobReceipt | null> {
  const receiptPath = autopilotReceiptPath(stateDirectory, runId);
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) {
      throw new Error("AUTOPILOT_RECEIPT_UNSAFE: durable receipt is not a bounded regular file.");
    }
    const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as AutopilotJobReceipt;
    if (parsed.schema_version !== "1.0" || parsed.mode !== "AUTOPILOT" || parsed.run_id !== runId) {
      throw new Error("AUTOPILOT_RECEIPT_INVALID: durable receipt does not match the requested run.");
    }
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

function initialReceipt(runId: string, webPackPath: string, now: () => Date): AutopilotJobReceipt {
  const timestamp = now().toISOString();
  return {
    schema_version: "1.0",
    mode: "AUTOPILOT",
    run_id: runId,
    web_pack_path: path.resolve(webPackPath),
    status: "RUNNING",
    last_transition: null,
    pending_review_job_id: null,
    web_review_rounds: 0,
    terminal_action: null,
    reason: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function finalStatus(snapshot: LifecycleSnapshot, plan: PlannedTransition): Pick<AutopilotJobReceipt, "status" | "terminal_action" | "reason"> {
  if (snapshot.web_review_state === "APPROVED") {
    return {
      status: "READY_FOR_YOU",
      terminal_action: "ASK_USER_TO_MERGE",
      reason: "The exact Draft PR head passed Web final review. Merge remains human-owned.",
    };
  }
  return {
    status: "NEEDS_YOU",
    terminal_action: "ASK_USER_TO_INTERVENE",
    reason: plan.reason,
  };
}

function retryDelay(result: ContinueResult, now: () => Date, fallback: number): number {
  const next = result.ledger.retry.next_retry_at;
  if (!next) return fallback;
  const due = Date.parse(next) - now().getTime();
  if (!Number.isFinite(due)) return fallback;
  return Math.max(1, Math.min(due, fallback));
}

export async function driveAutopilotJob(options: {
  bridge: WebBridge;
  runId: string;
  webPackPath: string;
  stateDirectory: string;
  configPath: string;
  pollIntervalMs?: number;
  maxCycles?: number;
  signal?: AbortSignal;
  now?: () => Date;
  dependencies?: Partial<AutopilotDependencies>;
}): Promise<AutopilotJobReceipt> {
  const deps = { ...productionDependencies, ...options.dependencies };
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = Math.max(250, Math.min(options.pollIntervalMs ?? 1_000, 10_000));
  const maxCycles = Math.max(1, Math.min(options.maxCycles ?? 96, 512));
  const resolvedPack = path.resolve(options.webPackPath);
  let receipt = await readAutopilotReceipt(options.stateDirectory, options.runId);
  if (!receipt) {
    receipt = initialReceipt(options.runId, resolvedPack, now);
    await persist(options.stateDirectory, receipt, now);
  } else if (receipt.web_pack_path !== resolvedPack) {
    throw new Error("AUTOPILOT_PACK_CONFLICT: an existing job is bound to a different Web implementation pack.");
  }

  if (receipt.status === "READY_FOR_YOU" || receipt.status === "NEEDS_YOU") return receipt;

  let cycles = 0;
  while (cycles < maxCycles) {
    if (options.signal?.aborted) {
      receipt.status = "PAUSED";
      receipt.reason = "Autopilot execution was interrupted and can be resumed from its durable checkpoint.";
      await persist(options.stateDirectory, receipt, now);
      return receipt;
    }

    const snapshot = await deps.readSnapshot(options.stateDirectory, options.runId);
    const plan = deps.deriveNext(snapshot);

    if (plan.transition === "WAIT_HUMAN" || plan.transition === "DONE") {
      Object.assign(receipt, finalStatus(snapshot, plan));
      await persist(options.stateDirectory, receipt, now);
      return receipt;
    }

    if (plan.transition === "REGISTER_WEB_PACK") {
      if (snapshot.registered_artifact_sha256 !== null) {
        receipt.status = "NEEDS_YOU";
        receipt.terminal_action = "ASK_USER_TO_INTERVENE";
        receipt.reason = "Web authority requested a new implementation pack after replan; AUTOPILOT will not replay the stale pack.";
        await persist(options.stateDirectory, receipt, now);
        return receipt;
      }
      const result = await deps.runNext({
        runId: options.runId,
        stateDirectory: options.stateDirectory,
        configPath: options.configPath,
        inputs: { web_pack_path: receipt.web_pack_path },
        now,
      });
      receipt.last_transition = result.planned.transition;
      receipt.status = result.progressed ? "RUNNING" : result.needs_input === "resume" ? "PAUSED" : "NEEDS_YOU";
      receipt.reason = result.progressed ? null : result.planned.reason;
      if (receipt.status === "NEEDS_YOU") receipt.terminal_action = "ASK_USER_TO_INTERVENE";
      if (result.progressed) cycles += 1;
      await persist(options.stateDirectory, receipt, now);
      if (!result.progressed) return receipt;
      continue;
    }

    if (plan.transition === "WAIT_WEB_VERDICT") {
      if (!receipt.pending_review_job_id) {
        const review = await deps.createFinalReview({
          bridge: options.bridge,
          runId: options.runId,
          stateDirectory: options.stateDirectory,
        });
        receipt.pending_review_job_id = review.job_id;
        receipt.status = "WAITING_WEB";
        receipt.reason = "Waiting for Web final review of the exact Result Bundle.";
        await persist(options.stateDirectory, receipt, now);
      }
      const verdict = await options.bridge.waitForVerdict(receipt.pending_review_job_id, options.signal);
      if (!verdict) {
        await deps.sleep(pollIntervalMs, options.signal);
        continue;
      }
      cycles += 1;
      const adopted = await deps.materializeVerdict({
        envelope: verdict,
        stateDirectory: options.stateDirectory,
        configPath: options.configPath,
        now,
      });
      receipt.web_review_rounds += 1;
      receipt.pending_review_job_id = null;
      receipt.last_transition = "WAIT_WEB_VERDICT";
      if (adopted.receipt.state === "APPROVED" || adopted.receipt.state === "REVISION_REQUESTED") {
        receipt.status = "RUNNING";
        receipt.reason = null;
        await persist(options.stateDirectory, receipt, now);
        continue;
      }
      receipt.status = "NEEDS_YOU";
      receipt.terminal_action = "ASK_USER_TO_INTERVENE";
      receipt.reason = adopted.receipt.state === "ESCALATED"
        ? "Web final review escalated a consequential decision to the user."
        : `Web final review stopped in non-autonomous state ${adopted.receipt.state}.`;
      await persist(options.stateDirectory, receipt, now);
      return receipt;
    }

    const result = await deps.runNext({
      runId: options.runId,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      now,
    });
    receipt.last_transition = result.planned.transition;
    if (result.progressed) {
      cycles += 1;
      receipt.status = "RUNNING";
      receipt.reason = null;
      await persist(options.stateDirectory, receipt, now);
      continue;
    }
    if (result.needs_input === "resume") {
      receipt.status = "PAUSED";
      receipt.reason = "The durable orchestration ledger is paused.";
      await persist(options.stateDirectory, receipt, now);
      return receipt;
    }
    if (result.ledger.status === "WAITING" && result.ledger.retry.next_retry_at) {
      receipt.status = "WAITING_RETRY";
      receipt.reason = result.planned.reason;
      await persist(options.stateDirectory, receipt, now);
      await deps.sleep(retryDelay(result, now, pollIntervalMs), options.signal);
      continue;
    }
    receipt.status = "NEEDS_YOU";
    receipt.terminal_action = "ASK_USER_TO_INTERVENE";
    receipt.reason = result.planned.reason;
    await persist(options.stateDirectory, receipt, now);
    return receipt;
  }

  receipt.status = "NEEDS_YOU";
  receipt.terminal_action = "ASK_USER_TO_INTERVENE";
  receipt.reason = `AUTOPILOT_CYCLE_BUDGET_EXHAUSTED: exceeded ${maxCycles} progressing orchestration cycles without reaching a safe terminal boundary.`;
  await persist(options.stateDirectory, receipt, now);
  return receipt;
}
