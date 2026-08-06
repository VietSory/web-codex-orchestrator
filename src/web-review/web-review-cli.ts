// CLI handlers for Phase 7: submit-web-verdict and web-review-status (P1-03)
import { submitWebVerdict, getWebReviewStatus } from "./web-review-service.js";
import { isWebReviewError, webReviewExitCode } from "./contracts.js";

export const SUBMIT_WEB_VERDICT_USAGE = `\
  wco submit-web-verdict --run-id <task-id:archive-sha256> --state-dir <directory> --config <config.json> --verdict <path> [--json]
  wco web-review-status --run-id <task-id:archive-sha256> --state-dir <directory> [--round <1-4>] [--json]`;

interface SubmitVerdictArgs {
  runId: string;
  stateDirectory: string;
  configPath: string;
  verdictPath: string;
  json: boolean;
}

interface ReviewStatusArgs {
  runId: string;
  stateDirectory: string;
  round?: number;
  json: boolean;
}

function parseSubmitVerdictArgs(args: string[]): SubmitVerdictArgs | null {
  let runId: string | undefined;
  let stateDirectory: string | undefined;
  let configPath: string | undefined;
  let verdictPath: string | undefined;
  let json = false;
  const seenFlags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      if (seenFlags.has("--json")) return null;
      seenFlags.add("--json");
      json = true;
      continue;
    }
    if (arg === "--run-id" || arg === "--state-dir" || arg === "--config" || arg === "--verdict") {
      if (seenFlags.has(arg)) return null; // Reject duplicate flags (P1-03)
      seenFlags.add(arg);
      const value = args[i + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--run-id") runId = value;
      else if (arg === "--state-dir") stateDirectory = value;
      else if (arg === "--config") configPath = value;
      else if (arg === "--verdict") verdictPath = value;
      i++;
      continue;
    }
    return null;
  }

  if (!runId || !stateDirectory || !configPath || !verdictPath) return null;
  return { runId, stateDirectory, configPath, verdictPath, json };
}

function parseReviewStatusArgs(args: string[]): ReviewStatusArgs | null {
  let runId: string | undefined;
  let stateDirectory: string | undefined;
  let round: number | undefined;
  let json = false;
  const seenFlags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      if (seenFlags.has("--json")) return null;
      seenFlags.add("--json");
      json = true;
      continue;
    }
    if (arg === "--run-id" || arg === "--state-dir") {
      if (seenFlags.has(arg)) return null; // Reject duplicate flags
      seenFlags.add(arg);
      const value = args[i + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--run-id") runId = value;
      else if (arg === "--state-dir") stateDirectory = value;
      i++;
      continue;
    }
    if (arg === "--round") {
      if (seenFlags.has("--round")) return null; // Reject duplicate --round (P1-03)
      seenFlags.add("--round");
      const value = args[i + 1];
      if (!value || value.startsWith("--") || !/^[1-4]$/.test(value)) return null;
      round = parseInt(value, 10);
      i++;
      continue;
    }
    return null;
  }

  if (!runId || !stateDirectory) return null;
  const res: ReviewStatusArgs = { runId, stateDirectory, json };
  if (round !== undefined) res.round = round;
  return res;
}

export async function runSubmitWebVerdictCommand(args: string[]): Promise<number> {
  const parsed = parseSubmitVerdictArgs(args);
  if (!parsed) {
    process.stderr.write(`Usage:\n${SUBMIT_WEB_VERDICT_USAGE}\n`);
    return 2;
  }

  try {
    const receipt = await submitWebVerdict({
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
      configPath: parsed.configPath,
      verdictPath: parsed.verdictPath,
    });

    if (parsed.json) {
      process.stdout.write(JSON.stringify(receipt) + "\n");
    } else {
      console.log(`State: ${receipt.state}`);
      console.log(`Round: ${receipt.review_round}`);
      console.log(`Action: ${receipt.action}`);
      console.log(`Verdict SHA: ${receipt.verdict_sha256}`);
      if (receipt.decision_event_sha256) console.log(`Decision Event SHA: ${receipt.decision_event_sha256}`);
      if (receipt.revision_request_sha256) console.log(`Revision Request SHA: ${receipt.revision_request_sha256}`);
    }

    const isTerminal = receipt.state === "APPROVED" || receipt.state === "REVISION_REQUESTED" || receipt.state === "ESCALATED";
    return isTerminal ? 0 : 1;
  } catch (error) {
    const code = isWebReviewError(error) ? error.code : "WEB_REVIEW_OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const blockedState = code.startsWith("WEB_REVIEW_") && code !== "WEB_REVIEW_OPERATIONAL_ERROR" && code !== "WEB_REVIEW_NETWORK_ERROR" && code !== "WEB_REVIEW_AUTH_ERROR" ? "BLOCKED" : "FAILED";

    if (parsed.json) {
      process.stdout.write(JSON.stringify({ state: blockedState, error: { code, message } }) + "\n");
    } else {
      process.stderr.write(`${code}: ${message}\n`);
    }
    return isWebReviewError(error) ? webReviewExitCode(error.code) : 3;
  }
}

export async function runWebReviewStatusCommand(args: string[]): Promise<number> {
  const parsed = parseReviewStatusArgs(args);
  if (!parsed) {
    process.stderr.write(`Usage:\n${SUBMIT_WEB_VERDICT_USAGE}\n`);
    return 2;
  }

  try {
    const statusOpts: import("./web-review-service.js").GetWebReviewStatusOptions = {
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
    };
    if (parsed.round !== undefined) statusOpts.round = parsed.round;

    // Status performs NO config load, network, validation or mutation (P1-03)
    const receipt = await getWebReviewStatus(statusOpts);

    if (!receipt) {
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ status: "NOT_FOUND" }) + "\n");
      } else {
        process.stderr.write("No web review receipt found.\n");
      }
      return 3;
    }

    if (parsed.json) {
      process.stdout.write(JSON.stringify(receipt) + "\n");
    } else {
      console.log(`State: ${receipt.state}`);
      console.log(`Round: ${receipt.review_round}`);
      console.log(`Action: ${receipt.action}`);
      if (receipt.verdict_sha256) console.log(`Verdict SHA: ${receipt.verdict_sha256}`);
    }

    const isTerminal = receipt.state === "APPROVED" || receipt.state === "REVISION_REQUESTED" || receipt.state === "ESCALATED";
    return isTerminal ? 0 : 1;
  } catch (error) {
    const code = isWebReviewError(error) ? error.code : "WEB_REVIEW_OPERATIONAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ state: "FAILED", error: { code, message } }) + "\n");
    } else {
      process.stderr.write(`${code}: ${message}\n`);
    }
    return 3;
  }
}
