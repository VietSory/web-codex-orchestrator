import { loadExecutorSource } from "./source.js";
import { loadExecutorResumeSource } from "./resume-source.js";
import { acquireExecutorLock, readExecutorReceipt, releaseExecutorLock, writeExecutorReceipt } from "./store.js";
import { applyExecutorTransaction, prepareExecutorTransaction } from "./applier.js";
import { attestExecutorChangeSet, attestExecutorResumeChangedPaths } from "./change-set.js";
import { boundedEvidence, type ExecutorReviewerPort, type ExecutorVerifierPort } from "./gates.js";
import { attestPersistedExecutorGateEvidence, persistExecutorEvidence } from "./evidence-store.js";
import { assertExecutorTransactionBoundToPack } from "./transaction-authority.js";
import { ExecutorError, type ExecutorReceipt } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  if (split <= 0 || !SHA256.test(runId.slice(split + 1))) throw new ExecutorError("EXECUTOR_INVALID_RUN_ID", "run_id must be <task-id>:<task-bundle-sha256>.");
  return { taskId: runId.slice(0, split), taskBundleSha256: runId.slice(split + 1) };
}
function timestamp(now: () => Date): string { return now().toISOString(); }
function pushError(receipt: ExecutorReceipt, code: string, message: string, now: () => Date): void {
  receipt.errors.push({ code: code.slice(0, 128), message: message.slice(0, 8192), at: timestamp(now) });
  if (receipt.errors.length > 32) receipt.errors.splice(0, receipt.errors.length - 32);
}
function assertReceiptAuthority(receipt: ExecutorReceipt, source: Awaited<ReturnType<typeof loadExecutorSource>>): void {
  const run = source.trusted.runReceipt;
  if (receipt.run_id !== run.run_id || receipt.task_id !== run.task_id || receipt.task_bundle_sha256 !== run.archive_sha256 || receipt.artifact_sha256 !== source.registration.artifact_sha256 || receipt.pack_id !== source.registration.pack_id || receipt.repository_id !== run.repository_id || receipt.base_branch !== run.base_branch || receipt.base_commit !== run.base_commit || receipt.base_tree_sha !== source.registration.repository.tree_sha || receipt.worktree_path !== run.worktree_path || receipt.registration_manifest_sha256 !== source.registration.manifest_sha256) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Persisted executor checkpoint no longer matches canonical Phase 3/9 authority.");
}
async function reattestDigest(receipt: ExecutorReceipt, expected: string | null): Promise<string> {
  const digest = await attestExecutorChangeSet(receipt);
  if (expected !== null && digest !== expected) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", "Worktree digest changed while an executor gate was running.");
  return digest;
}
async function failToWeb(receipt: ExecutorReceipt, stateDirectory: string, code: string, message: string, now: () => Date): Promise<ExecutorReceipt> {
  receipt.state = "ESCALATE_TO_WEB";
  pushError(receipt, code, message, now);
  receipt.updated_at = timestamp(now);
  await writeExecutorReceipt(stateDirectory, receipt);
  return receipt;
}

export async function executeRegisteredWebPack(options: {
  runId: string;
  artifactSha256: string;
  stateDirectory: string;
  configPath: string;
  verifier: ExecutorVerifierPort;
  reviewer: ExecutorReviewerPort;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<ExecutorReceipt> {
  const now = options.now ?? (() => new Date());
  const identity = splitRunId(options.runId);
  const lock = await acquireExecutorLock(options.stateDirectory, identity.taskId, identity.taskBundleSha256, options.artifactSha256);
  let receipt: ExecutorReceipt | null = null;
  try {
    receipt = await readExecutorReceipt(options.stateDirectory, identity.taskId, identity.taskBundleSha256, options.artifactSha256);
    if (receipt?.state === "ESCALATE_TO_WEB" || receipt?.state === "FAILED") return receipt;

    const source = receipt
      ? await loadExecutorResumeSource({ runId: options.runId, artifactSha256: options.artifactSha256, stateDirectory: options.stateDirectory, configPath: options.configPath })
      : await loadExecutorSource({ runId: options.runId, artifactSha256: options.artifactSha256, stateDirectory: options.stateDirectory, configPath: options.configPath });

    if (receipt) {
      assertReceiptAuthority(receipt, source);
      assertExecutorTransactionBoundToPack(receipt, source.pack);
      await attestPersistedExecutorGateEvidence(options.stateDirectory, receipt);
      if (receipt.state === "READY_FOR_PUBLISH") {
        await reattestDigest(receipt, receipt.change_set_digest);
        return receipt;
      }
      await attestExecutorResumeChangedPaths(receipt);
    }

    if (!receipt) {
      receipt = await prepareExecutorTransaction({
        stateDirectory: options.stateDirectory,
        runId: options.runId,
        taskId: identity.taskId,
        taskBundleSha256: identity.taskBundleSha256,
        artifactSha256: options.artifactSha256,
        pack: source.pack,
        repositoryId: source.trusted.runReceipt.repository_id,
        baseBranch: source.trusted.runReceipt.base_branch,
        baseCommit: source.trusted.runReceipt.base_commit,
        baseTreeSha: source.registration.repository.tree_sha,
        worktreePath: source.trusted.runReceipt.worktree_path,
        registrationManifestSha256: source.registration.manifest_sha256,
        now,
      });
    }

    if (["PREPARED", "APPLYING"].includes(receipt.state)) receipt = await applyExecutorTransaction({ stateDirectory: options.stateDirectory, receipt, pack: source.pack, now });
    if (!["APPLIED", "VERIFYING", "REVIEWING_TERRA", "REVIEWING_SOL"].includes(receipt.state)) throw new ExecutorError("EXECUTOR_STATE_INVALID", `Unexpected executor state '${receipt.state}'.`);

    const digest = await reattestDigest(receipt, receipt.change_set_digest);
    receipt.change_set_digest = digest;
    receipt.updated_at = timestamp(now);
    await writeExecutorReceipt(options.stateDirectory, receipt);
    const baseRequest = {
      run_id: receipt.run_id,
      artifact_sha256: receipt.artifact_sha256,
      worktree_path: receipt.worktree_path,
      accepted_bundle_path: source.trusted.runReceipt.accepted_bundle_path,
      change_set_digest: digest,
      changed_paths: receipt.operations.map((operation) => operation.path).sort(),
      ...(options.signal ? { signal: options.signal } : {}),
    };

    if (!receipt.verification.passed || receipt.verification.change_set_digest !== digest) {
      receipt.state = "VERIFYING";
      receipt.updated_at = timestamp(now);
      await writeExecutorReceipt(options.stateDirectory, receipt);
      const result = await options.verifier.verify(baseRequest);
      await reattestDigest(receipt, digest);
      const evidence = boundedEvidence(result.evidence);
      await persistExecutorEvidence({ stateDirectory: options.stateDirectory, receipt, name: `verification-${receipt.verification.rounds + 1}`, bytes: evidence.bytes, expectedSha256: evidence.sha256 });
      receipt.verification.rounds += 1;
      receipt.verification.passed = result.passed;
      receipt.verification.change_set_digest = digest;
      receipt.verification.evidence_sha256 = evidence.sha256;
      if (!result.passed) return await failToWeb(receipt, options.stateDirectory, "EXECUTOR_VERIFICATION_FAILED", "Deterministic verification rejected the exact registered Web result.", now);
      receipt.updated_at = timestamp(now);
      await writeExecutorReceipt(options.stateDirectory, receipt);
    }

    if (receipt.terra_review.verdict !== "APPROVE" || receipt.terra_review.change_set_digest !== digest) {
      receipt.state = "REVIEWING_TERRA";
      receipt.updated_at = timestamp(now);
      await writeExecutorReceipt(options.stateDirectory, receipt);
      const result = await options.reviewer.review({ ...baseRequest, reviewer: "terra", prior_evidence_sha256: receipt.verification.evidence_sha256 ? [receipt.verification.evidence_sha256] : [] });
      await reattestDigest(receipt, digest);
      const evidence = boundedEvidence(result.evidence);
      await persistExecutorEvidence({ stateDirectory: options.stateDirectory, receipt, name: `terra-${receipt.terra_review.rounds + 1}`, bytes: evidence.bytes, expectedSha256: evidence.sha256 });
      receipt.terra_review.rounds += 1;
      receipt.terra_review.verdict = result.verdict;
      receipt.terra_review.change_set_digest = digest;
      receipt.terra_review.evidence_sha256 = evidence.sha256;
      if (result.verdict !== "APPROVE") return await failToWeb(receipt, options.stateDirectory, "EXECUTOR_REVIEW_REJECTED", `Terra review returned ${result.verdict}; Phase 10 does not redesign the Web pack.`, now);
      receipt.updated_at = timestamp(now);
      await writeExecutorReceipt(options.stateDirectory, receipt);
    }

    if (receipt.sol_review.verdict !== "APPROVE" || receipt.sol_review.change_set_digest !== digest) {
      receipt.state = "REVIEWING_SOL";
      receipt.updated_at = timestamp(now);
      await writeExecutorReceipt(options.stateDirectory, receipt);
      const prior = [receipt.verification.evidence_sha256, receipt.terra_review.evidence_sha256].filter((value): value is string => Boolean(value));
      const result = await options.reviewer.review({ ...baseRequest, reviewer: "sol", prior_evidence_sha256: prior });
      await reattestDigest(receipt, digest);
      const evidence = boundedEvidence(result.evidence);
      await persistExecutorEvidence({ stateDirectory: options.stateDirectory, receipt, name: `sol-${receipt.sol_review.rounds + 1}`, bytes: evidence.bytes, expectedSha256: evidence.sha256 });
      receipt.sol_review.rounds += 1;
      receipt.sol_review.verdict = result.verdict;
      receipt.sol_review.change_set_digest = digest;
      receipt.sol_review.evidence_sha256 = evidence.sha256;
      if (result.verdict !== "APPROVE") return await failToWeb(receipt, options.stateDirectory, "EXECUTOR_REVIEW_REJECTED", `Sol review returned ${result.verdict}; Phase 10 does not redesign the Web pack.`, now);
      receipt.updated_at = timestamp(now);
      await writeExecutorReceipt(options.stateDirectory, receipt);
    }

    await reattestDigest(receipt, digest);
    receipt.state = "READY_FOR_PUBLISH";
    receipt.updated_at = timestamp(now);
    await writeExecutorReceipt(options.stateDirectory, receipt);
    return receipt;
  } catch (error) {
    if (receipt && error instanceof ExecutorError && !["READY_FOR_PUBLISH", "ESCALATE_TO_WEB"].includes(receipt.state)) return await failToWeb(receipt, options.stateDirectory, error.code, error.message, now);
    throw error;
  } finally {
    await releaseExecutorLock(lock);
  }
}
