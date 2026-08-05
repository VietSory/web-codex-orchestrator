import { createDraftPullRequestForRun } from "./phase5b-service.js";
import { DraftPullRequestError } from "./contracts.js";

export const DRAFT_PR_USAGE = `
Usage: wco create-draft-pr --run-id <task-id:archive-sha256> --state-dir <directory> --config <config.json> [--json]

Creates a GitHub Draft Pull Request deterministically.

Options:
  --run-id <id>      The exact run ID to publish.
  --state-dir <dir>  Path to the state directory containing the execution.
  --config <path>    Path to the trusted configuration JSON.
  --json             Output exactly one JSON object on success.
`;

export async function runDraftPrCommand(
  args: string[],
  serviceEntrypoint = createDraftPullRequestForRun
): Promise<number> {
  let runId: string | undefined;
  let stateDirectory: string | undefined;
  let configPath: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--run-id") {
      runId = args[++i];
    } else if (arg === "--state-dir") {
      stateDirectory = args[++i];
    } else if (arg === "--config") {
      configPath = args[++i];
    } else if (arg === "--json") {
      jsonOutput = true;
    } else {
      process.stderr.write(`Unknown or duplicate flag: ${arg}\n`);
      return 2; // CLI usage
    }
  }

  if (!runId || !stateDirectory || !configPath) {
    process.stderr.write(DRAFT_PR_USAGE.trim() + "\n");
    return 2;
  }

  try {
    const receipt = await serviceEntrypoint({ runId, stateDirectory, configPath });

    if (receipt.state === "OPEN") {
      if (jsonOutput) {
        process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
      } else {
        process.stdout.write(`Draft PR state: OPEN\n`);
        process.stdout.write(`Pull request: #${receipt.pull_number}\n`);
        process.stdout.write(`URL: ${receipt.pull_url}\n`);
        process.stdout.write(`Head commit: ${receipt.expected_head_sha}\n`);
      }
      return 0;
    }

    if (receipt.state === "CONFLICT") {
      if (jsonOutput) {
        process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
      } else {
        process.stderr.write(`Draft PR state: CONFLICT\n`);
        process.stderr.write(`Reason: ${receipt.conflict_reason}\n`);
      }
      return 1; // CONFLICT is exit code 1
    }
    
    // For READY_FOR_CREATE or CREATE_UNCERTAIN that didn't throw an error directly
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
    } else {
      process.stderr.write(`Draft PR state: ${receipt.state}\n`);
    }
    return 3;
    
  } catch (error: any) {
    let errorCode = 1; // Default to config/receipt/etc
    let errorMessage = error.message || "Unknown error";

    if (error instanceof DraftPullRequestError) {
      const code3Errors = [
        "PR_API_UNAUTHORIZED", "PR_API_FORBIDDEN", "PR_API_NOT_FOUND", "PR_API_RATE_LIMITED",
        "PR_API_REDIRECT_REJECTED", "PR_API_RESPONSE_TOO_LARGE", "PR_API_RESPONSE_INVALID",
        "PR_API_FAILED", "PR_CREATE_REJECTED", "PR_CREATE_UNCERTAIN"
      ];
      if (code3Errors.includes(error.code)) {
        errorCode = 3;
      }
      errorMessage = `${error.code}: ${error.details}`;
    }

    if (errorMessage.length > 16384) {
      errorMessage = errorMessage.substring(0, 16384);
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ error: errorMessage }) + "\n");
    } else {
      process.stderr.write(`Error: ${errorMessage}\n`);
    }

    return errorCode;
  }
}
