import type { AutopilotJobReceipt } from "../orchestration/autopilot-job.js";

const STAGE_LABELS: Record<AutopilotJobReceipt["stage"], string> = {
  EXECUTE: "IMPLEMENTATION",
  PUBLISH: "PUBLISHING",
  DRAFT_PR: "DRAFT_PR",
  PACKAGE_RESULT: "RESULT_BUNDLE",
  WAIT_WEB: "WEB_FINAL_REVIEW",
  REVISE: "REVISING",
  DONE: "READY_FOR_YOU",
};

export function formatAutopilotStatus(receipt: AutopilotJobReceipt | null): string {
  if (!receipt) return "AUTOPILOT · CONTRACT_READY";
  if (receipt.status === "READY_FOR_YOU") return "AUTOPILOT · READY_FOR_YOU";
  if (receipt.status === "NEEDS_YOU") return "AUTOPILOT · NEEDS_YOU";
  if (receipt.status === "PAUSED") return "AUTOPILOT · PAUSED";
  if (receipt.status === "WAITING_RETRY") return `AUTOPILOT · RETRYING_${STAGE_LABELS[receipt.stage]}`;
  if (receipt.status === "WAITING_WEB") return "AUTOPILOT · WEB_FINAL_REVIEW";
  return `AUTOPILOT · ${STAGE_LABELS[receipt.stage]}`;
}

export function formatAutopilotOutcome(receipt: AutopilotJobReceipt, draftPrUrl: string | null): string {
  if (receipt.status === "READY_FOR_YOU") {
    return [
      "AUTOPILOT · READY FOR YOU",
      `Draft PR      ${draftPrUrl ?? "ready"}`,
      "Verification  passed",
      "Code reviewer approved",
      "Web final     approved",
      "Action        review and merge when ready",
    ].join("\n");
  }
  if (receipt.status === "PAUSED") return ["AUTOPILOT · PAUSED", "Safe checkpoint saved. Use /run to resume."].join("\n");
  if (receipt.status === "NEEDS_YOU") return ["AUTOPILOT · NEEDS YOU", receipt.reason ?? "WCO stopped at a human-owned or non-retryable boundary.", "No merge action was taken. Use /status, /review and /doctor for evidence."].join("\n");
  return [formatAutopilotStatus(receipt), receipt.reason ?? "WCO stopped before a terminal user boundary.", "Use /run to continue from durable state."].join("\n");
}
