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
import { getRevisionStatus } from "../revision/revision-service.js";
import { getWebReviewStatus, submitWebVerdict } from "../web-review/web-review-service.js";
import { completeAttempt } from "./controller.js";
import { OrchestrationError, type RunLedger, type TransitionAttempt, type TransitionKind } from "./contracts.js";
import { attestReadyExecutorSnapshot } from "./executor-ready.js";
import { readSelectedArtifact, readSelectedArtifactSelection } from "./artifact-binding.js";
import { sealTransitionRequest } from "./retry-policy.js";
import { openDraftPullRequestForExecutorSnapshot } from "./draft-pr.js";
import { packageResultForRun } from "./package-result.js";
import {
  assertRevisionResultForOrchestration,
  attestRevisionAuthorityForOrchestration,
  revisionOrchestrationPayload,
  revisionOrchestrationUsage,
  reviseRunForOrchestration,
} from "./revise.js";

const SHA256 = /^[a-f0-9]{64}$/;

function splitRunId(runId: string): { taskId: string; taskBundleSha256: string } {
  const split = runId.lastIndexOf(":");
  const taskId = runId.slice(0, split);
  const taskBundleSha256 = runId.slice(split + 1);
  if (split <= 0 || !taskId || !SHA256.test(taskBundleSha256)) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Invalid run_id for recovery.");
  return { taskId, taskBundleSha256 };
}

async function readExecutorReceiptForRun(stateDirectory: string, runId: string, artifactSha256: string): Promise<ExecutorReceipt | null> {
  const id = splitRunId(runId);
  return await readExecutorReceipt(stateDirectory, id.taskId, id.taskBundleSha256, artifactSha256);
}

async function readPublishReceiptForRun(stateDirectory: string, runId: string, artifactSha256: string): Promise<GitPublishReceipt | null> {
  const id = splitRunId(runId);
  const directory = executorPaths(stateDirectory, id.taskId, id.taskBundleSha256, artifactSha256).directory;
  return await readGitPublishReceipt(path.join(directory, "publish", "git-publish.json"));
}

async function attestTerminalExecutorSnapshot(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string }): Promise<ExecutorReceipt> {
  const receipt = await readExecutorReceiptForRun(options.stateDirectory, options.runId, options.artifactSha256);
  if (!receipt || !["ESCALATE_TO_WEB", "FAILED"].includes(receipt.state)) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "Executor terminal recovery evidence is missing or is not terminal.");
  const source = await loadExecutorResumeSource(options);
  const run = source.trusted.runReceipt;
  if (receipt.run_id !== run.run_id || receipt.task_id !== run.task_id || receipt.task_bundle_sha256 !== run.archive_sha256 || receipt.artifact_sha256 !== source.registration.artifact_sha256 || receipt.pack_id !== source.registration.pack_id || receipt.repository_id !== run.repository_id || receipt.base_branch !== run.base_branch || receipt.base_commit !== run.base_commit || receipt.base_tree_sha !== source.registration.repository.tree_sha || receipt.worktree_path !== run.worktree_path || receipt.registration_manifest_sha256 !== source.registration.manifest_sha256) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "Terminal executor receipt no longer matches canonical Phase 3/9 authority.");
  assertExecutorTransactionBoundToPack(receipt, source.pack);
  await attestExecutorTransactionBackups(options.stateDirectory, receipt);
  await attestPersistedExecutorGateEvidence(options.stateDirectory, receipt);
  await attestExecutorResumeChangedPaths(receipt);
  return receipt;
}

export interface RecoveryDependencies {
  readSelectedArtifact: typeof readSelectedArtifact;
  readSelectedArtifactSelection: typeof readSelectedArtifactSelection;
  readExecutorReceiptForRun: typeof readExecutorReceiptForRun;
  readPublishReceiptForRun: typeof readPublishReceiptForRun;
  attestTerminalExecutorSnapshot: typeof attestTerminalExecutorSnapshot;
  attestReadyExecutorSnapshot: typeof attestReadyExecutorSnapshot;
  openDraftPr: typeof openDraftPullRequestForExecutorSnapshot;
  packageResult: typeof packageResultForRun;
  getWebReviewStatus: typeof getWebReviewStatus;
  submitWebVerdict: typeof submitWebVerdict;
  getRevisionStatus: typeof getRevisionStatus;
  attestRevisionAuthority: typeof attestRevisionAuthorityForOrchestration;
  reviseRun: typeof reviseRunForOrchestration;
  completeAttempt: typeof completeAttempt;
}

const productionDependencies: RecoveryDependencies = {
  readSelectedArtifact,
  readSelectedArtifactSelection,
  readExecutorReceiptForRun,
  readPublishReceiptForRun,
  attestTerminalExecutorSnapshot,
  attestReadyExecutorSnapshot,
  openDraftPr: openDraftPullRequestForExecutorSnapshot,
  packageResult: packageResultForRun,
  getWebReviewStatus,
  submitWebVerdict,
  getRevisionStatus,
  attestRevisionAuthority: attestRevisionAuthorityForOrchestration,
  reviseRun: reviseRunForOrchestration,
  completeAttempt,
};

function sealedRequestMatches(attempt: TransitionAttempt, transition: TransitionKind, payload: unknown): boolean {
  return attempt.transition === transition && attempt.request_sha256 === sealTransitionRequest(transition, payload);
}
function assertSealedRequest(attempt: TransitionAttempt, transition: TransitionKind, payload: unknown): void {
  if (!sealedRequestMatches(attempt, transition, payload)) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", `Canonical ${transition} recovery evidence does not match the sealed attempt request.`);
}
function equalSortedPaths(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort(); const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}
function resolveStateRelative(stateDirectory: string, relativePath: string): string {
  const root = path.resolve(stateDirectory);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "Persisted Web verdict path escapes the state directory.");
  return target;
}

export async function recoverCompletedAttempt(options: { stateDirectory: string; runId: string; configPath: string; ledger: RunLedger; dependencies?: Partial<RecoveryDependencies>; now?: () => Date }): Promise<RunLedger> {
  const attempt = options.ledger.current_attempt;
  if (!attempt || attempt.status !== "STARTED") return options.ledger;
  const deps = { ...productionDependencies, ...options.dependencies };
  const now = options.now ?? (() => new Date());

  if (attempt.transition === "REGISTER_WEB_PACK") {
    const selection = await deps.readSelectedArtifactSelection(options.stateDirectory, options.runId);
    if (!selection) return options.ledger;
    if (Date.parse(selection.selected_at) < Date.parse(attempt.started_at)) return options.ledger;
    const selected = selection.registration;
    assertSealedRequest(attempt, "REGISTER_WEB_PACK", { archive_sha256: selected.artifact_sha256, pack_id: selected.pack_id });
    return await deps.completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: attempt.attempt_id, result: { artifact_sha256: selected.artifact_sha256, manifest_sha256: selected.manifest_sha256 }, nextTransition: "EXECUTE_REGISTERED_PACK", now: now() });
  }

  if (attempt.transition === "EXECUTE_REGISTERED_PACK") {
    const selected = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
    if (!selected) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "A sealed executor attempt exists without its selected Phase 9 artifact binding.");
    assertSealedRequest(attempt, "EXECUTE_REGISTERED_PACK", { artifact_sha256: selected.artifact_sha256, manifest_sha256: selected.manifest_sha256 });
    const receipt = await deps.readExecutorReceiptForRun(options.stateDirectory, options.runId, selected.artifact_sha256);
    if (!receipt || !["READY_FOR_PUBLISH", "ESCALATE_TO_WEB", "FAILED"].includes(receipt.state)) return options.ledger;
    const attestedReceipt = receipt.state === "READY_FOR_PUBLISH" ? (await deps.attestReadyExecutorSnapshot({ runId: options.runId, artifactSha256: selected.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath })).receipt : await deps.attestTerminalExecutorSnapshot({ runId: options.runId, artifactSha256: selected.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath });
    const nextTransition: TransitionKind = attestedReceipt.state === "READY_FOR_PUBLISH" ? "PUBLISH" : attestedReceipt.state === "ESCALATE_TO_WEB" ? "REGISTER_WEB_PACK" : "WAIT_HUMAN";
    return await deps.completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: attempt.attempt_id, result: { state: attestedReceipt.state, change_set_digest: attestedReceipt.change_set_digest, artifact_sha256: attestedReceipt.artifact_sha256, adopted_after_restart: true }, nextTransition, now: now() });
  }

  if (attempt.transition === "PUBLISH") {
    const selected = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
    if (!selected) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "A sealed publish attempt exists without its selected Phase 9 artifact binding.");
    const ready = await deps.attestReadyExecutorSnapshot({ runId: options.runId, artifactSha256: selected.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath });
    assertSealedRequest(attempt, "PUBLISH", { artifact_sha256: selected.artifact_sha256, change_set_digest: ready.changeSetDigest });
    const publish = await deps.readPublishReceiptForRun(options.stateDirectory, options.runId, selected.artifact_sha256);
    if (!publish || publish.state !== "PUSHED") return options.ledger;
    const run = ready.source.trusted.runReceipt;
    if (publish.run_id !== options.runId || publish.run_id !== run.run_id || publish.base_commit !== run.base_commit || publish.branch_name !== run.branch_name || publish.remote_name !== run.remote || publish.allowed_remote_url !== run.remote_url || publish.change_set_sha256 !== ready.changeSetDigest || !equalSortedPaths(publish.expected_paths, ready.changedPaths) || !publish.commit_sha || publish.remote_branch_sha !== publish.commit_sha) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "PUSHED recovery receipt does not bind the exact run, change-set, delivery target and remote commit.");
    return await deps.completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: attempt.attempt_id, result: { state: publish.state, commit_sha: publish.commit_sha, remote_branch_sha: publish.remote_branch_sha, adopted_after_restart: true }, nextTransition: "OPEN_DRAFT_PR", now: now() });
  }

  if (attempt.transition === "OPEN_DRAFT_PR") {
    const selected = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
    if (!selected) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "A sealed Draft PR attempt exists without its selected artifact binding.");
    const ready = await deps.attestReadyExecutorSnapshot({ runId: options.runId, artifactSha256: selected.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath });
    assertSealedRequest(attempt, "OPEN_DRAFT_PR", { artifact_sha256: selected.artifact_sha256, change_set_digest: ready.changeSetDigest });
    const draft = await deps.openDraftPr({ runId: options.runId, artifactSha256: selected.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath, now });
    if (draft.state !== "OPEN" || draft.observed_draft !== true || draft.observed_state !== "open" || draft.observed_head_sha !== draft.expected_head_sha || draft.pull_number === null) return options.ledger;
    return await deps.completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: attempt.attempt_id, result: { state: draft.state, pull_number: draft.pull_number, expected_head_sha: draft.expected_head_sha, request_sha256: draft.request_sha256, adopted_after_restart: true }, nextTransition: "PACKAGE_RESULT", now: now() });
  }

  if (attempt.transition === "PACKAGE_RESULT") {
    const selected = await deps.readSelectedArtifact(options.stateDirectory, options.runId);
    if (!selected) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "A sealed Result Bundle attempt exists without its selected artifact binding.");
    const ready = await deps.attestReadyExecutorSnapshot({ runId: options.runId, artifactSha256: selected.artifact_sha256, stateDirectory: options.stateDirectory, configPath: options.configPath });
    assertSealedRequest(attempt, "PACKAGE_RESULT", { artifact_sha256: selected.artifact_sha256, change_set_digest: ready.changeSetDigest });
    const result = await deps.packageResult({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, now });
    if (result.state !== "READY_FOR_WEB_REVIEW" || result.run_id !== options.runId || result.archive_sha256 === null || result.published_commit_sha !== result.remote_branch_sha || result.pull_request.draft !== true || result.pull_request.head_sha !== result.published_commit_sha || result.change_set_sha256 !== ready.changeSetDigest) return options.ledger;
    return await deps.completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: attempt.attempt_id, result: { state: result.state, archive_sha256: result.archive_sha256, published_commit_sha: result.published_commit_sha, pull_number: result.pull_request.number, reviewed_entry_set_sha256: result.reviewed_entry_set_sha256, adopted_after_restart: true }, nextTransition: "WAIT_WEB_VERDICT", now: now() });
  }

  if (attempt.transition === "WAIT_WEB_VERDICT") {
    const review = await deps.getWebReviewStatus({ runId: options.runId, stateDirectory: options.stateDirectory });
    if (!review || !["APPROVED", "REVISION_REQUESTED", "ESCALATED"].includes(review.state) || !review.verdict_sha256 || !review.artifact_paths.verdict) return options.ledger;
    assertSealedRequest(attempt, "WAIT_WEB_VERDICT", { verdict_sha256: review.verdict_sha256 });
    const verdictPath = resolveStateRelative(options.stateDirectory, review.artifact_paths.verdict);
    const revalidated = await deps.submitWebVerdict({ runId: options.runId, stateDirectory: options.stateDirectory, configPath: options.configPath, verdictPath, now });
    if (revalidated.verdict_sha256 !== review.verdict_sha256 || revalidated.fresh_attested_head_sha === null || revalidated.fresh_attested_head_sha !== revalidated.published_commit_sha || revalidated.decision_event_sha256 === null) throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", "Recovered Web verdict no longer passes exact fresh-head attestation.");
    const nextTransition: TransitionKind = revalidated.state === "REVISION_REQUESTED" ? "REVISE" : "WAIT_HUMAN";
    return await deps.completeAttempt({ stateDirectory: options.stateDirectory, runId: options.runId, attemptId: attempt.attempt_id, result: { state: revalidated.state, review_round: revalidated.review_round, verdict_sha256: revalidated.verdict_sha256, decision_event_sha256: revalidated.decision_event_sha256, revision_request_sha256: revalidated.revision_request_sha256, published_commit_sha: revalidated.published_commit_sha, pull_request_number: revalidated.pull_request_number, fresh_attested_head_sha: revalidated.fresh_attested_head_sha, adopted_after_restart: true }, nextTransition, now: now() });
  }

  if (attempt.transition === "REVISE") {
    const authority = await deps.attestRevisionAuthority({ runId: options.runId, stateDirectory: options.stateDirectory });
    assertSealedRequest(attempt, "REVISE", revisionOrchestrationPayload(authority));
    const existing = await deps.getRevisionStatus(options.stateDirectory, options.runId, authority.revisionRound);
    if (!existing || existing.state !== "RESULT_READY") return options.ledger;
    const revision = await deps.reviseRun({ runId: options.runId, revisionRound: authority.revisionRound, stateDirectory: options.stateDirectory, configPath: options.configPath, now });
    try {
      assertRevisionResultForOrchestration(options.runId, revision, authority);
    } catch (error) {
      throw new OrchestrationError("ORCHESTRATION_RECOVERY_CONFLICT", `Recovered revision result no longer matches sealed authority: ${error instanceof Error ? error.message : String(error)}`);
    }
    return await deps.completeAttempt({
      stateDirectory: options.stateDirectory,
      runId: options.runId,
      attemptId: attempt.attempt_id,
      result: {
        state: revision.state,
        revision_round: revision.revision_round,
        previous_pr_head_sha: revision.previous_pr_head_sha,
        new_published_commit_sha: revision.new_published_commit_sha,
        remote_branch_sha: revision.remote_branch_sha,
        pull_request_number: revision.pull_request_number,
        result_bundle_sha256: revision.result_bundle_sha256,
        result_manifest_sha256: revision.result_manifest_sha256,
        next_review_round: revision.next_review_round,
        adopted_after_restart: true,
      },
      nextTransition: "WAIT_WEB_VERDICT",
      usage: revisionOrchestrationUsage(revision),
      now: now(),
    });
  }

  return options.ledger;
}
