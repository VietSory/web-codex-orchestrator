import { readExecutorReceipt } from "../executor/store.js";
import { loadExecutorResumeSource } from "../executor/resume-source.js";
import { assertExecutorTransactionBoundToPack, attestExecutorTransactionBackups } from "../executor/transaction-authority.js";
import { attestPersistedExecutorGateEvidence } from "../executor/evidence-store.js";
import { attestExecutorChangeSet } from "../executor/change-set.js";
import { executorPaths } from "../executor/paths.js";
import { OrchestrationError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id for executor publication.");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}

export async function attestReadyExecutorSnapshot(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string }) {
  const id = splitRunId(options.runId);
  const receipt = await readExecutorReceipt(options.stateDirectory, id.taskId, id.taskBundleSha256, options.artifactSha256);
  if (!receipt || receipt.run_id !== options.runId || receipt.artifact_sha256 !== options.artifactSha256 || receipt.state !== "READY_FOR_PUBLISH" || receipt.change_set_digest === null) throw new OrchestrationError("ORCHESTRATION_EXECUTOR_NOT_READY", "Phase 10 exact executor result is not READY_FOR_PUBLISH.");
  const source = await loadExecutorResumeSource({ runId: options.runId, artifactSha256: options.artifactSha256, stateDirectory: options.stateDirectory, configPath: options.configPath });
  if (receipt.pack_id !== source.registration.pack_id || receipt.registration_manifest_sha256 !== source.registration.manifest_sha256 || receipt.repository_id !== source.trusted.runReceipt.repository_id || receipt.base_branch !== source.trusted.runReceipt.base_branch || receipt.base_commit !== source.trusted.runReceipt.base_commit || receipt.worktree_path !== source.trusted.runReceipt.worktree_path) throw new OrchestrationError("ORCHESTRATION_EXECUTOR_AUTHORITY_DRIFT", "READY executor receipt no longer binds canonical Phase 3/9 authority.");
  assertExecutorTransactionBoundToPack(receipt, source.pack);
  await attestExecutorTransactionBackups(options.stateDirectory, receipt);
  await attestPersistedExecutorGateEvidence(options.stateDirectory, receipt);
  const digest = await attestExecutorChangeSet(receipt);
  if (digest !== receipt.change_set_digest || receipt.verification.change_set_digest !== digest || receipt.terra_review.change_set_digest !== digest || receipt.sol_review.change_set_digest !== digest || !receipt.verification.passed || receipt.terra_review.verdict !== "APPROVE" || receipt.sol_review.verdict !== "APPROVE") throw new OrchestrationError("ORCHESTRATION_EXECUTOR_AUTHORITY_DRIFT", "READY executor approvals no longer bind the exact current change-set.");
  const paths = executorPaths(options.stateDirectory, id.taskId, id.taskBundleSha256, options.artifactSha256);
  return { receipt, source, executorDirectory: paths.directory, changeSetDigest: digest, changedPaths: receipt.operations.map((operation) => operation.path).sort() };
}
