import { readExecutorReceipt } from "../executor/store.js";
import { loadExecutorResumeSource } from "../executor/resume-source.js";
import { assertExecutorTransactionBoundToPack, attestExecutorTransactionBackups } from "../executor/transaction-authority.js";
import { attestPersistedExecutorGateEvidence } from "../executor/evidence-store.js";
import { attestExecutorChangeSet, attestPublishedExecutorChangeSet, readExecutorWorktreeHead } from "../executor/change-set.js";
import { executorPaths } from "../executor/paths.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import path from "node:path";
import { OrchestrationError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } { const split = runId.lastIndexOf(":"); if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id for executor publication."); return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) }; }
export async function attestReadyExecutorSnapshot(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string }) {
  const id = splitRunId(options.runId);
  const paths = executorPaths(options.stateDirectory, id.taskId, id.taskBundleSha256, options.artifactSha256);
  const receipt = await readExecutorReceipt(options.stateDirectory, id.taskId, id.taskBundleSha256, options.artifactSha256);
  if (!receipt || receipt.run_id !== options.runId || receipt.artifact_sha256 !== options.artifactSha256 || receipt.state !== "READY_FOR_PUBLISH" || receipt.change_set_digest === null) throw new OrchestrationError("ORCHESTRATION_EXECUTOR_NOT_READY", "Phase 10 exact executor result is not READY_FOR_PUBLISH.");
  const publish = await readGitPublishReceipt(path.join(paths.directory, "publish", "git-publish.json"));
  let published = publish?.state === "COMMITTED" || publish?.state === "PUSHED" ? publish : null;
  if (publish?.state === "READY_FOR_COMMIT") {
    const head = await readExecutorWorktreeHead(receipt);
    // Git may have durably created the exact approved commit immediately before
    // a crash prevented the COMMITTED receipt update. Attest that candidate as
    // strictly as a persisted commit; GitPublisher remains responsible for
    // adopting it and persisting the recovery checkpoint before any push.
    if (head !== receipt.base_commit) published = { ...publish, state: "COMMITTED", commit_sha: head, committed_at: publish.updated_at };
  }
  const source = await loadExecutorResumeSource({ runId: options.runId, artifactSha256: options.artifactSha256, stateDirectory: options.stateDirectory, configPath: options.configPath, ...(published?.commit_sha ? { expectedWorktreeHead: published.commit_sha } : {}) });
  if (receipt.pack_id !== source.registration.pack_id || receipt.registration_manifest_sha256 !== source.registration.manifest_sha256 || receipt.repository_id !== source.trusted.runReceipt.repository_id || receipt.base_branch !== source.trusted.runReceipt.base_branch || receipt.base_commit !== source.trusted.runReceipt.base_commit || receipt.worktree_path !== source.trusted.runReceipt.worktree_path) throw new OrchestrationError("ORCHESTRATION_EXECUTOR_AUTHORITY_DRIFT", "READY executor receipt no longer binds canonical Phase 3/9 authority.");
  assertExecutorTransactionBoundToPack(receipt, source.pack);
  await attestExecutorTransactionBackups(options.stateDirectory, receipt);
  await attestPersistedExecutorGateEvidence(options.stateDirectory, receipt);
  if (published && (published.run_id !== options.runId || published.base_commit !== receipt.base_commit || published.branch_name !== source.trusted.runReceipt.branch_name || published.remote_name !== source.trusted.runReceipt.remote || published.allowed_remote_url !== source.trusted.runReceipt.remote_url || published.change_set_sha256 !== receipt.change_set_digest || published.commit_sha === null || (published.state === "PUSHED" && published.remote_branch_sha !== published.commit_sha))) throw new OrchestrationError("ORCHESTRATION_EXECUTOR_AUTHORITY_DRIFT", "Published receipt no longer binds the exact READY executor authority.");
  const digest = published ? await attestPublishedExecutorChangeSet(receipt, published) : await attestExecutorChangeSet(receipt);
  if (digest !== receipt.change_set_digest || receipt.verification.change_set_digest !== digest || receipt.terra_review.change_set_digest !== digest || receipt.sol_review.change_set_digest !== digest || !receipt.verification.passed || receipt.terra_review.verdict !== "APPROVE" || receipt.sol_review.verdict !== "APPROVE") throw new OrchestrationError("ORCHESTRATION_EXECUTOR_AUTHORITY_DRIFT", "READY executor approvals no longer bind the exact current change-set.");
  return { receipt, source, executorDirectory: paths.directory, changeSetDigest: digest, changedPaths: receipt.operations.map((operation) => operation.path).sort() };
}
