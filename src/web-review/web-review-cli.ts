// CLI handlers for Phase 7: submit-web-verdict and web-review-status
import { submitWebVerdict, getWebReviewStatus } from "./web-review-service.js";
import { isWebReviewError, webReviewExitCode } from "./contracts.js";
import { GitHubRestAttestationClient } from "../result-bundle/github-attestation.js";
import { loadTrustedConfig } from "../config/config-loader.js";

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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      if (json) return null;
      json = true;
      continue;
    }
    if (arg === "--run-id" || arg === "--state-dir" || arg === "--config" || arg === "--verdict") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--run-id" && runId === undefined) runId = value;
      else if (arg === "--state-dir" && stateDirectory === undefined) stateDirectory = value;
      else if (arg === "--config" && configPath === undefined) configPath = value;
      else if (arg === "--verdict" && verdictPath === undefined) verdictPath = value;
      else return null;
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      if (json) return null;
      json = true;
      continue;
    }
    if (arg === "--run-id" || arg === "--state-dir") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--run-id" && runId === undefined) runId = value;
      else if (arg === "--state-dir" && stateDirectory === undefined) stateDirectory = value;
      i++;
      continue;
    }
    if (arg === "--round") {
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
    const configResult = await loadTrustedConfig(parsed.configPath);
    const githubConfig = configResult.github_pull_request;
    let githubClient: GitHubRestAttestationClient | undefined;

    if (githubConfig) {
      const tokenKey = githubConfig.authentication.token_environment_key;
      const token = process.env[tokenKey];
      if (token) {
        githubClient = new GitHubRestAttestationClient(token);
      }
    }

    const opts: import("./web-review-service.js").SubmitWebVerdictOptions = {
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
      configPath: parsed.configPath,
      verdictPath: parsed.verdictPath,
    };
    if (githubClient) opts.githubClient = githubClient;

    const receipt = await submitWebVerdict(opts);

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
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ state: "FAILED", error: { code, message } }) + "\n");
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
