import path from "node:path";
import { executorPaths } from "../executor/paths.js";
import { loadExecutorResumeSource } from "../executor/resume-source.js";
import { readExecutorReceipt } from "../executor/store.js";
import { attestExecutorResumeChangedPaths } from "../executor/change-set.js";
import { attestPersistedExecutorGateEvidence } from "../executor/evidence-store.js";
import { assertExecutorTransactionBoundToPack, attestExecutorTransactionBackups } from "../executor/transaction-authority.js";
import type { ExecutorReceipt } from "../executor/contracts.js";
import { readGitPublishReceipt } from "../publish/publish-store.js";
import type { GitPublishReceipt } from "../publish/contracts.js";
import { completeAttempt } from "./controller.js";
import { OrchestrationError, type RunLedger, type TransitionAttempt, type TransitionKind } from "./contracts.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import { sealTransitionRequest } from "./retry-policy.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split);
  const taskBundleSha256 = runId.slice(split + 1);
  if (split <= 0 || !taskId || !SHA256.test(taskBundleSha256)) {
    throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id for recovery.");
  }
  return { taskId, taskBundleSha256 };
}

async function readExecutorReceiptForRun(
  stateDirectory: string,
  runId: string,
  artifactSha256: string,
): Promise<ExecutorReceipt | null> {
  const id = splitRunId(runId);
  return await readExecutorReceipt(stateDirectory, id.taskId, id.taskBundleSha256, artifactSha256);
}

async function readPublishReceiptForRun(
  stateDirectory: string,
  runId: string,
  artifactSha256: string,
): Promise<GitPublishReceipt | null> {
  const id = splitRunId(runId);
  const directory = executorPaths(stateDirectory, id.taskId, id.taskBundleSha256, artifactSha256).directory;
  return await readGitPublishReceipt(path.join(directory, "publish", "git-publish.json"));
}

async function attestTerminalExecutorSnapshot(options: {
  runId: string;
  artifactSha256: string;
  stateDirectory: string;
  configPath: string;
}): Promise<ExecutorReceipt> {
  const receipt = await readExecutorReceiptForRun(
    options.stateDirectory,
    options.runId,
    options.artifactSha256,
  );
  if (!receipt || !["ESCALATE_TO_WEB", "FAILED"].includes(receipt.state)) {
    throw new OrchestrationError(
      "ORCHESTRATION_RECOVERY_CONFLICT",
      "Executor terminal recovery evidence is missing or is not terminal.",
    );
  }

  const source = await loadExecutorResumeSource(options);
  const run = source.trusted.runReceipt;
  if (
    receipt.run_id !== run.run_id ||
    receipt.task_id !== run.task_id ||
    receipt.task_bundle_sha256 !== run.archive_sha256 ||
    receipt.artifact_sha256 !== source.registration.artifact_sha256 ||
    receipt.pack_id !== source.registration.pack_id ||
    receipt.repository_id !== run.repository_id ||
    receipt.base_branch !== run.base_branch ||
    receipt.base_commit !== run.base_commit ||
    receipt.base_tree_sha !== source.registration.repository.tree_sha ||
    receipt.worktree_path !== run.worktree_path ||
    receipt.registration_manifest_sha256 !== source.registration.manifest_sha256
  ) {
    throw new OrchestrationError(
      "ORCHESTRATION_RECOVERY_CONFLICT",
      "Terminal executor receipt no longer matches canonical Phase 3/9 authority.",
    );
  }

  assertExecutorTransactionBoundToPack(receipt, source.pack);
  await attestExecutorTransactionBackups(options.stateDirectory, receipt);
  await attestPersistedExecutorGateEvidence(options.stateDirectory, receipt);
  await attestExecutorResumeChangedPaths(receipt);
  return receipt;
}

export interface RecoveryDependencies {
  readSelectedArtifact: typeof readSelectedArtifact;
  readExecutorReceiptForRun: typeof readExecutorReceiptForRun;
  readPublishReceiptForRun: typeof readPublishReceiptForRun;
  attestTerminalExecutorSnapshot: typeof attestTerminalExecutorSnapshot;
  attestReadyExecutorSnapshot: typeof attestReadyExecutorSnapshot;
  completeAttempt: typeof completeAttempt;
}

const productionDependencies: RecoveryDependencies = {
  readSelectedArtifact,
  readExecutorReceiptForRun,
  readPublishReceiptForRun,
  attestTerminalExecutorSnapshot,
  attestReadyExecutorSnapshot,
  completeAttempt,
};

function assertSealedRequest(
  attempt: TransitionAttempt,
  transition: TransitionKind,
  payload: unknown,
): void {
  const expected = sealTransitionRequest(transition, payload);
  if (attempt.transition !== transition || attempt.request_sha256 !== expected) {
    throw new OrchestrationError(
      "ORCHESTRATION_RECOVERY_CONFLICT",
      `Canonical ${transition} recovery evidence does not match the sealed attempt request.`,
    );
  }
}

export async function recoverCompletedAttempt(options: {
  stateDirectory: string;
  runId: string;
  configPath: string;
  ledger: RunLedger;
  dependencies?: Partial<RecoveryDependencies>;
  now?: () => Date;
}): Promise<RunLedger> {
  const attempt = options.ledger.current_attempt;
  if (!attempt || attempt.status !== "STARTED") return options.ledger;
  const deps = { ...productionDependencies, ...options.dependencies };
  const now = options.now ?? (() => new Date());

  if (attempt.transition === "REGISTER_WEB_PACK") {
    const selected = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
    if (!selected) return options.ledger;
    assertSealedRequest(attempt, "REGISTER_WEB_PACK", {
      archive_sha256: selected.artifact_sha256,
      pack_id: selected.pack_id,
    });
    return await deps.completeAttempt({
      stateDirectory: options.stateDirectory,
      runId: options.runId,
      attemptId: attempt.attempt_id,
      result: {
        artifact_sha256: selected.artifact_sha256,
        manifest_sha256: selected.manifest_sha256,
      },
      nextTransition: "EXECUTE_REGISTERED_PACK",
      now: now(),
    });
  }

  if (attempt.transition === "EXECUTE_REGISTERED_PACK") {
    const selected = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
    if (!selected) {
      throw new OrchestrationError(
        "ORCHESTRATION_RECOVERY_CONFLICT",
        "A sealed executor attempt exists without its selected Phase 9 artifact binding.",
      );
    }
    assertSealedRequest(attempt, "EXECUTE_REGISTERED_PACK", {
      artifact_sha256: selected.artifact_sha256,
      manifest_sha256: selected.manifest_sha256,
    });
    const receipt = await deps.readExecutorReceiptForRun(
      options.stateDirectory,
      options.runId,
      selected.artifact_sha256,
    );
    if (!receipt || !["READY_FOR_PUBLISH", "ESCALATE_TO_WEB", "FAILED"].includes(receipt.state)) {
      return options.ledger;
    }

    let attestedReceipt: ExecutorReceipt;
    if (receipt.state === "READY_FOR_PUBLISH") {
      const ready = await deps.attestReadyExecutorSnapshot({
        runId: options.runId,
        artifactSha256: selected.artifact_sha256,
        stateDirectory: options.stateDirectory,
        configPath: options.configPath,
      });
      attestedReceipt = ready.receipt;
    } else {
      attestedReceipt = await deps.attestTerminalExecutorSnapshot({
        runId: options.runId,
        artifactSha256: selected.artifact_sha256,
        stateDirectory: options.stateDirectory,
        configPath: options.configPath,
      });
    }

    const nextTransition: TransitionKind =
      attestedReceipt.state === "READY_FOR_PUBLISH"
        ? "PUBLISH"
        : attestedReceipt.state === "ESCALATE_TO_WEB"
          ? "REGISTER_WEB_PACK"
          : "WAIT_HUMAN";
    return await deps.completeAttempt({
      stateDirectory: options.stateDirectory,
      runId: options.runId,
      attemptId: attempt.attempt_id,
      result: {
        state: attestedReceipt.state,
        change_set_digest: attestedReceipt.change_set_digest,
        artifact_sha256: attestedReceipt.artifact_sha256,
        adopted_after_restart: true,
      },
      nextTransition,
      now: now(),
    });
  }

  if (attempt.transition === "PUBLISH") {
    const selected = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
    if (!selected) {
      throw new OrchestrationError(
        "ORCHESTRATION_RECOVERY_CONFLICT",
        "A sealed publish attempt exists without its selected Phase 9 artifact binding.",
      );
    }
    const ready = await deps.attestReadyExecutorSnapshot({
      runId: options.runId,
      artifactSha256: selected.artifact_sha256,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
    });
    assertSealedRequest(attempt, "PUBLISH", {
      artifact_sha256: selected.artifact_sha256,
      change_set_digest: ready.changeSetDigest,
    });
    const publish = await deps.readPublishReceiptForRun(
      options.stateDirectory,
      options.runId,
      selected.artifact_sha256,
    );
    if (!publish || publish.state !== "PUSHED") return options.ledger;
    if (!publish.commit_sha || publish.remote_branch_sha !== publish.commit_sha) {
      throw new OrchestrationError(
        "ORCHESTRATION_RECOVERY_CONFLICT",
        "PUSHED recovery receipt does not bind the remote branch to the exact commit.",
      );
    }
    return await deps.completeAttempt({
      stateDirectory: options.stateDirectory,
      runId: options.runId,
      attemptId: attempt.attempt_id,
      result: {
        state: publish.state,
        commit_sha: publish.commit_sha,
        remote_branch_sha: publish.remote_branch_sha,
        adopted_after_restart: true,
      },
      nextTransition: "OPEN_DRAFT_PR",
      now: now(),
    });
  }

  return options.ledger;
}
