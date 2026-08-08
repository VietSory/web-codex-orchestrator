import { readExecutorReceipt } from "../executor/store.js";
import { executorPaths } from "../executor/paths.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import type { LifecycleSnapshot } from "./planner.js";

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}

export async function readLifecycleSnapshot(stateDirectory: string, runId: string): Promise<LifecycleSnapshot> {
  const selected = await readSelectedArtifact(stateDirectory, runId);
  if (!selected) return { registered_artifact_sha256: null, executor_state: null, publish_state: null, draft_pr_state: null, result_bundle_ready: false, web_review_state: null, revision_state: null, revision_result_ready: false };
  const id = splitRunId(runId);
  const executor = await readExecutorReceipt(stateDirectory, id.taskId, id.taskBundleSha256, selected.artifact_sha256);
  const directory = executorPaths(stateDirectory, id.taskId, id.taskBundleSha256, selected.artifact_sha256).directory;
  const publish = await readGitPublishReceipt(directory);
  return {
    registered_artifact_sha256: selected.artifact_sha256,
    executor_state: executor?.state ?? null,
    publish_state: publish?.state ?? null,
    draft_pr_state: null,
    result_bundle_ready: false,
    web_review_state: null,
    revision_state: null,
    revision_result_ready: false,
  };
}
