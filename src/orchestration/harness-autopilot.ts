import type { ExecutorReceipt } from "../executor/contracts.js";
import type { DraftPullRequestReceipt } from "../pull-request/contracts.js";
import type { GitPublishReceipt } from "../publish/contracts.js";
import type { ResultBundleReceipt } from "../result-bundle/contracts.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import { openDraftPullRequestForExecutorSnapshot } from "./draft-pr.js";
import { executeHarnessRun } from "./harness-runner.js";
import { packageResultForRun } from "./package-result.js";
import { publishReadyExecutorSnapshot } from "./p10-publish.js";
import { OrchestrationError } from "./contracts.js";

async function selectedArtifactSha(options: { runId: string; stateDirectory: string }): Promise<string> {
  const selected = await readSelectedArtifact(options.stateDirectory, options.runId);
  if (!selected) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "AUTOPILOT requires the frozen Web implementation artifact before this stage.");
  return selected.artifact_sha256;
}

export async function executeAutopilotHarness(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  webPackPath?: string;
  signal?: AbortSignal;
}): Promise<ExecutorReceipt> {
  return await executeHarnessRun({
    runId: options.runId,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    reviewStrategy: "model",
    ...(options.webPackPath ? { webPackPath: options.webPackPath } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function publishAutopilotHarness(options: { runId: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<GitPublishReceipt> {
  return await publishReadyExecutorSnapshot({ ...options, artifactSha256: await selectedArtifactSha(options) });
}

export async function draftAutopilotHarness(options: { runId: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<DraftPullRequestReceipt> {
  return await openDraftPullRequestForExecutorSnapshot({ ...options, artifactSha256: await selectedArtifactSha(options) });
}

export async function packageAutopilotHarness(options: { runId: string; stateDirectory: string; configPath: string; now?: () => Date }): Promise<ResultBundleReceipt> {
  return await packageResultForRun(options);
}
