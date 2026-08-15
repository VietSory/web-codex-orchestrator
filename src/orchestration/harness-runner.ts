import type { ExecutorReceipt, ExecutorReviewStrategy } from "../executor/contracts.js";
import { createProductionModelReviewer, createProductionVerifier } from "../executor/production-gates.js";
import { executeRegisteredWebPack } from "../executor/service.js";
import { readAndValidateWebImplementationPack } from "../web-authority/pack-reader.js";
import { registerWebImplementationPack } from "../web-authority/authority-service.js";
import { readSelectedArtifact, selectRegisteredArtifact } from "./artifact-binding.js";
import { OrchestrationError } from "./contracts.js";

/**
 * Normal PAIR and AUTOPILOT share one mutation engine. Models author/review;
 * only the Harness validates and applies repository operations.
 */
export async function executeHarnessRun(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  reviewStrategy: ExecutorReviewStrategy;
  webPackPath?: string;
  signal?: AbortSignal;
}): Promise<ExecutorReceipt> {
  let registration = await readSelectedArtifact(options.stateDirectory, options.runId);

  if (options.webPackPath) {
    const pack = await readAndValidateWebImplementationPack(options.webPackPath);
    if (pack.manifest.run_id !== options.runId) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_DRIFT", "Web implementation pack belongs to a different run.");
    if (registration) {
      if (registration.artifact_sha256 !== pack.archive_sha256) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_DRIFT", "A different Web implementation artifact is already frozen for this run.");
    } else {
      registration = await registerWebImplementationPack({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, archivePath: options.webPackPath });
      await selectRegisteredArtifact({ stateDirectory: options.stateDirectory, runId: options.runId, artifactSha256: registration.artifact_sha256 });
    }
  }

  if (!registration) throw new OrchestrationError("ORCHESTRATION_ARTIFACT_INVALID", "No registered Web implementation pack is selected for this run.");

  const verifier = await createProductionVerifier({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath });
  if (options.reviewStrategy === "web") {
    return await executeRegisteredWebPack({
      runId: options.runId,
      artifactSha256: registration.artifact_sha256,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      verifier,
      reviewStrategy: "web",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  const reviewer = await createProductionModelReviewer({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath });
  return await executeRegisteredWebPack({
    runId: options.runId,
    artifactSha256: registration.artifact_sha256,
    stateDirectory: options.stateDirectory,
    configPath: options.configPath,
    verifier,
    reviewer,
    reviewStrategy: "model",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
