import type { AutopilotJobReceipt } from "../orchestration/autopilot-job.js";

const STAGE_LABELS: Record<AutopilotJobReceipt["stage"], string> = {
  EXECUTE: "Implementing",
  PUBLISH: "Publishing the branch",
  DRAFT_PR: "Preparing the Draft PR",
  PACKAGE_RESULT: "Preparing review evidence",
  WAIT_WEB: "Final review",
  REVISE: "Applying review fixes",
  DONE: "Ready for you",
};

export function formatAutopilotStatus(receipt: AutopilotJobReceipt | null): string {
  if (!receipt) return "AUTOPILOT · Plan ready";
  if (receipt.status === "READY_FOR_YOU") return "AUTOPILOT · Ready for you";
  if (receipt.status === "NEEDS_YOU") return "AUTOPILOT · Needs your attention";
  if (receipt.status === "PAUSED") return "AUTOPILOT · Paused";
  if (receipt.status === "WAITING_RETRY") return `AUTOPILOT · Retrying — ${STAGE_LABELS[receipt.stage]}`;
  if (receipt.status === "WAITING_WEB") return "AUTOPILOT · Final review";
  return `AUTOPILOT · ${STAGE_LABELS[receipt.stage]}`;
}

export function formatAutopilotOutcome(receipt: AutopilotJobReceipt, draftPrUrl: string | null): string {
  if (receipt.status === "READY_FOR_YOU") {
    return [
      "AUTOPILOT · Ready for you",
      `Draft PR      ${draftPrUrl ?? "ready"}`,
      "Checks        passed",
      "Code review   approved",
      "Final review  approved",
      "Next          review the Draft PR and merge when ready",
    ].join("\n");
  }
  if (receipt.status === "PAUSED") return ["AUTOPILOT · Paused", "Progress is saved. Use /run to continue."].join("\n");
  if (receipt.status === "NEEDS_YOU") return ["AUTOPILOT · Needs your attention", receipt.reason ?? "WCO stopped at a decision or issue that needs you.", "Nothing was merged. Use /status and /review for details; use /doctor if something is unavailable."].join("\n");
  return [formatAutopilotStatus(receipt), receipt.reason ?? "WCO stopped before the task was ready for you.", "Use /run to continue from saved progress."].join("\n");
}
