import type { WebBridge } from "../web-bridge/web-bridge.js";
import { driveAutopilotJob, type AutopilotDependencies, type AutopilotJobReceipt } from "./autopilot-job.js";
import { parseJobMode, type JobMode } from "./job-mode.js";

export interface PairJobBoundary {
  mode: "PAIR";
  status: "INTERACTIVE";
  terminal_action: null;
  reason: string;
}

export type JobDriveResult = PairJobBoundary | AutopilotJobReceipt;

export async function driveJob(options: {
  mode?: JobMode | string | null;
  bridge: WebBridge;
  runId: string;
  webPackPath?: string;
  stateDirectory: string;
  configPath: string;
  pollIntervalMs?: number;
  maxCycles?: number;
  signal?: AbortSignal;
  now?: () => Date;
  dependencies?: Partial<AutopilotDependencies>;
}): Promise<JobDriveResult> {
  const mode = parseJobMode(options.mode);
  if (mode === "PAIR") {
    return {
      mode: "PAIR",
      status: "INTERACTIVE",
      terminal_action: null,
      reason: "PAIR remains user-collaborative and is intentionally driven by the existing interactive Web/TUI workflow.",
    };
  }
  return await driveAutopilotJob({
    bridge: options.bridge,
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    ...(options.webPackPath ? { webPackPath: options.webPackPath } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.maxCycles !== undefined ? { maxCycles: options.maxCycles } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
  });
}
