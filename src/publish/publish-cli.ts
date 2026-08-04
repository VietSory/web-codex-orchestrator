import { redact } from "../evidence/log-redaction.js";
import { GitPublishError } from "./contracts.js";
import { publishPhase4Run } from "./phase4-publish-service.js";

interface PublishArguments {
  runId: string;
  stateDirectory: string;
  configPath: string;
  json: boolean;
}

function parsePublishArguments(args: readonly string[]): PublishArguments | null {
  let runId: string | undefined;
  let stateDirectory: string | undefined;
  let configPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--json") {
      if (json) return null;
      json = true;
      continue;
    }

    if (
      argument === "--run-id" ||
      argument === "--state-dir" ||
      argument === "--config"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return null;

      if (argument === "--run-id" && runId === undefined) runId = value;
      else if (argument === "--state-dir" && stateDirectory === undefined) {
        stateDirectory = value;
      } else if (argument === "--config" && configPath === undefined) {
        configPath = value;
      } else return null;

      index += 1;
      continue;
    }

    return null;
  }

  if (!runId || !stateDirectory || !configPath) return null;
  return { runId, stateDirectory, configPath, json };
}

function publishExitCode(code: string): number {
  if (
    [
      "PUBLISH_REQUEST_INVALID",
      "PUBLISH_RECEIPT_INVALID",
      "PUBLISH_RECEIPT_INCONSISTENT",
      "PUBLISH_WORKTREE_UNSAFE",
      "PUBLISH_BASE_MISMATCH",
      "PUBLISH_BRANCH_POLICY_VIOLATION",
      "PUBLISH_REMOTE_MISMATCH",
      "PUBLISH_PHASE4_NOT_READY",
      "PUBLISH_CHANGE_SET_STALE",
      "PUBLISH_APPROVED_SNAPSHOT_MISSING",
      "PUBLISH_STAGE_MISMATCH",
      "PUBLISH_INDEX_MISMATCH",
      "PUBLISH_COMMIT_MISMATCH",
      "PUBLISH_RECOVERY_FAILED",
      "PUBLISH_REMOTE_BRANCH_EXISTS",
      "PUBLISH_IDENTITY_UNAVAILABLE",
      "PUBLISH_AUTH_UNAVAILABLE",
    ].includes(code)
  ) {
    return 1;
  }

  return 3;
}

export const PUBLISH_USAGE =
  "  wco publish --run-id <task-id:archive-sha256> --state-dir <directory> --config <config.json> [--json]";

export async function runPublishCommand(
  args: readonly string[],
  printUsage: () => void,
): Promise<void> {
  const parsed = parsePublishArguments(args);
  if (!parsed) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    const receipt = await publishPhase4Run({
      runId: parsed.runId,
      stateDirectory: parsed.stateDirectory,
      configPath: parsed.configPath,
    });

    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } else {
      console.log(`Publish state: ${receipt.state}`);
      console.log(`Commit: ${receipt.commit_sha ?? "none"}`);
      console.log(`Remote branch: ${receipt.remote_branch_sha ?? "none"}`);
    }

    if (receipt.state !== "PUSHED") process.exitCode = 1;
  } catch (error) {
    const code =
      error instanceof GitPublishError ? error.code : "OPERATIONAL_ERROR";
    const message = redact(
      error instanceof Error ? error.message : String(error),
    ).slice(0, 16_384);

    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ state: "FAILED", error: { code, message } })}\n`,
      );
    } else {
      process.stderr.write(`${code}: ${message}\n`);
    }

    process.exitCode = publishExitCode(code);
  }
}
