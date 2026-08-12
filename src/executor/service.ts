import type { WebImplementationPack } from "../web-authority/contracts.js";
import { loadExecutorSource } from "./source.js";
import { loadExecutorResumeSource } from "./resume-source.js";
import { acquireExecutorLock, readExecutorReceipt, releaseExecutorLock, writeExecutorReceipt } from "./store.js";
import { applyExecutorTransaction, prepareExecutorTransaction } from "./applier.js";
import { attestExecutorChangeSet, attestExecutorResumeChangedPaths, effectiveExecutorChangedPaths } from "./change-set.js";
import { boundedEvidence, type ExecutorReviewerPort, type ExecutorVerifierPort } from "./gates.js";
import { attestPersistedExecutorGateEvidence, persistExecutorEvidence } from "./evidence-store.js";
import { assertExecutorTransactionBoundToPack, attestExecutorTransactionBackups } from "./transaction-authority.js";
import { selectSmartContext } from "./smart-context.js";
import { applyReviewerRepair, bindReviewerRepair } from "./repair.js";
import { finalWebRepairCompletesModelAuthority } from "./review-authority.js";
import { ExecutorError, type ExecutorReceipt, type ExecutorReviewStrategy, type ExecutorUsage } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
type EffectiveReviewStrategy = ExecutorReviewStrategy | "legacy";

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
function safeUsageAdd(left: number, right: number): number { const value = left + right; if (!Number.isSafeInteger(value)) throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", "Reviewer usage counter overflowed safe integer bounds."); return value; }
function recordUsage(receipt: ExecutorReceipt, usage: ExecutorUsage | undefined): void {
  if (!usage) return;
  const current = receipt.usage ?? { model_turns: 0, input_tokens: 0, output_tokens: 0 };
  if ([usage.model_turns, usage.input_tokens, usage.output_tokens].some((value) => !Number.isSafeInteger(value) || value < 0)) throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", "Reviewer usage contains an invalid counter.");
  receipt.usage = { model_turns: safeUsageAdd(current.model_turns, usage.model_turns), input_tokens: safeUsageAdd(current.input_tokens, usage.input_tokens), output_tokens: safeUsageAdd(current.output_tokens, usage.output_tokens) };
}
function assertBudgetPolicy(reviewer: ExecutorReviewerPort): NonNullable<ExecutorReviewerPort["budget_policy"]> | null {
  const policy = reviewer.budget_policy; if (!policy) return null;
  if ([policy.maximum_model_turns, policy.maximum_elapsed_ms, policy.maximum_input_tokens, policy.maximum_output_tokens].some((value) => !Number.isSafeInteger(value) || value < 1)) throw new ExecutorError("EXECUTOR_BUDGET_EXHAUSTED", "Trusted executor review budget policy is invalid.");
  return policy;
}
function assertMeasuredUsageWithinBudget(receipt: ExecutorReceipt, reviewer: ExecutorReviewerPort): void {
  const policy = assertBudgetPolicy(reviewer); if (!policy || !receipt.usage) return;
  if (receipt.usage.input_tokens > policy.maximum_input_tokens || receipt.usage.output_tokens > policy.maximum_output_tokens) throw new ExecutorError("EXECUTOR_BUDGET_EXHAUSTED", "Measured executor review token usage exceeded the configured budget; no later model call is permitted.");
}
function assertNoAmbiguousReviewResume(receipt: ExecutorReceipt, reviewer: ExecutorReviewerPort): void {
  if (!reviewer.budget_policy) return;
  const kind = receipt.reviewer_selection?.kind ?? reviewer.reviewer_kind;
  if ((kind === undefined || kind === "terra") && receipt.state === "REVIEWING_TERRA" && receipt.terra_review.verdict === null) throw new ExecutorError("EXECUTOR_AMBIGUOUS_RECOVERY", "A Terra review turn may have started before interruption but no durable verdict exists; WCO will not replay an ambiguous model call.");
  if ((kind === undefined || kind === "sol") && receipt.state === "REVIEWING_SOL" && receipt.sol_review.verdict === null) throw new ExecutorError("EXECUTOR_AMBIGUOUS_RECOVERY", "A Sol review turn may have started before interruption but no durable verdict exists; WCO will not replay an ambiguous model call.");
}
async function reserveReviewTurn(receipt: ExecutorReceipt, reviewer: ExecutorReviewerPort, stateDirectory: string, now: () => Date): Promise<void> {
  const policy = assertBudgetPolicy(reviewer); if (!policy) return;
  const current = receipt.usage ?? { model_turns: 0, input_tokens: 0, output_tokens: 0 }; const elapsed = now().getTime() - Date.parse(receipt.created_at);
  if (!Number.isFinite(elapsed) || elapsed >= policy.maximum_elapsed_ms) throw new ExecutorError("EXECUTOR_BUDGET_EXHAUSTED", "Executor review wall-clock budget is exhausted before the provider call.");
  if (current.model_turns >= policy.maximum_model_turns) throw new ExecutorError("EXECUTOR_BUDGET_EXHAUSTED", "Executor review model-turn budget is exhausted before the provider call.");
  if (current.input_tokens >= policy.maximum_input_tokens || current.output_tokens >= policy.maximum_output_tokens) throw new ExecutorError("EXECUTOR_BUDGET_EXHAUSTED", "Measured executor review token budget is exhausted before the next provider call.");
  receipt.usage = { ...current, model_turns: safeUsageAdd(current.model_turns, 1) }; receipt.updated_at = timestamp(now); await writeExecutorReceipt(stateDirectory, receipt);
}
function assertReceiptAuthority(receipt: ExecutorReceipt, source: Awaited<ReturnType<typeof loadExecutorSource>>): void {
  const run = source.trusted.runReceipt;
  if (receipt.run_id !== run.run_id || receipt.task_id !== run.task_id || receipt.task_bundle_sha256 !== run.archive_sha256 || receipt.artifact_sha256 !== source.registration.artifact_sha256 || receipt.pack_id !== source.registration.pack_id || receipt.repository_id !== run.repository_id || receipt.base_branch !== run.base_branch || receipt.base_commit !== run.base_commit || receipt.base_tree_sha !== source.registration.repository.tree_sha || receipt.worktree_path !== run.worktree_path || receipt.registration_manifest_sha256 !== source.registration.manifest_sha256) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Persisted executor checkpoint no longer matches canonical Phase 3/9 authority.");
}
async function reattestDigest(receipt: ExecutorReceipt, expected: string | null): Promise<string> { const digest = await attestExecutorChangeSet(receipt); if (expected !== null && digest !== expected) throw new ExecutorError("EXECUTOR_UNREGISTERED_CHANGE", "Worktree digest changed while an executor gate was running."); return digest; }
async function failToWeb(receipt: ExecutorReceipt, stateDirectory: string, code: string, message: string, now: () => Date): Promise<ExecutorReceipt> { receipt.state = "ESCALATE_TO_WEB"; pushError(receipt, code, message, now); receipt.updated_at = timestamp(now); await writeExecutorReceipt(stateDirectory, receipt); return receipt; }
async function failTerminal(receipt: ExecutorReceipt, stateDirectory: string, code: string, message: string, now: () => Date): Promise<ExecutorReceipt> { receipt.state = "FAILED"; pushError(receipt, code, message, now); receipt.updated_at = timestamp(now); await writeExecutorReceipt(stateDirectory, receipt); return receipt; }

function selectedReviewReady(receipt: ExecutorReceipt, digest: string, kind: "terra" | "sol"): boolean {
  if (finalWebRepairCompletesModelAuthority(receipt, digest)) return true;
  const review = kind === "terra" ? receipt.terra_review : receipt.sol_review;
  if (review.verdict === "APPROVE" && review.change_set_digest === digest) return true;
  return Boolean(receipt.repair?.state === "VERIFIED" && receipt.repair.reviewer === kind && receipt.repair.final_change_set_digest === digest && review.verdict === "REVISE" && review.change_set_digest === receipt.repair.source_change_set_digest && review.evidence_sha256 === receipt.repair.source_review_evidence_sha256);
}
function assertReadyEvidence(receipt: ExecutorReceipt): void {
  const digest = receipt.change_set_digest;
  if (!digest || !receipt.verification.passed || receipt.verification.change_set_digest !== digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY executor is missing deterministic verification for the exact digest.");
  if (receipt.review_strategy === "web") {
    if (receipt.reviewer_selection !== undefined || receipt.terra_review.verdict !== null || receipt.sol_review.verdict !== null) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Web-review Harness receipt contains unexpected model-review authority.");
    if (receipt.repair && (receipt.repair.reviewer !== "web" || receipt.repair.state !== "VERIFIED" || receipt.repair.final_change_set_digest !== digest)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY Web-review Harness receipt contains an unverified or stale bounded repair.");
    return;
  }
  if (receipt.review_strategy === "model" && !receipt.reviewer_selection) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Model-review Harness receipt is missing selected reviewer authority.");
  if (receipt.reviewer_selection?.kind === "terra") { if (!selectedReviewReady(receipt, digest, "terra")) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY executor is missing selected Terra approval or verified adaptive repair authority."); return; }
  if (receipt.reviewer_selection?.kind === "sol") { if (!selectedReviewReady(receipt, digest, "sol")) throw new ExecutorError("EXECUTOR_STATE_INVALID", "READY executor is missing selected Sol approval or verified adaptive repair authority."); return; }
  if (receipt.terra_review.verdict !== "APPROVE" || receipt.terra_review.change_set_digest !== digest || receipt.sol_review.verdict !== "APPROVE" || receipt.sol_review.change_set_digest !== digest) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Legacy READY executor is missing Terra and Sol approvals for the exact digest.");
}
function canBindStrategy(receipt: ExecutorReceipt): boolean { return receipt.reviewer_selection === undefined && receipt.terra_review.rounds === 0 && receipt.sol_review.rounds === 0 && receipt.terra_review.verdict === null && receipt.sol_review.verdict === null && ["PREPARED", "APPLYING", "APPLIED", "VERIFYING"].includes(receipt.state); }

async function completeAdaptiveRepair(options: { receipt: ExecutorReceipt; stateDirectory: string; verifier: ExecutorVerifierPort; pack: WebImplementationPack; acceptedBundlePath: string; signal?: AbortSignal; now: () => Date }): Promise<ExecutorReceipt> {
  let receipt = options.receipt; const repair = receipt.repair;
  if (!repair) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "Adaptive repair completion has no durable proposal.");
  if (repair.state === "PROPOSED" || repair.state === "APPLYING") receipt = await applyReviewerRepair({ stateDirectory: options.stateDirectory, receipt, pack: options.pack, now: options.now });
  if (receipt.repair?.state === "APPLIED") {
    const finalDigest = await reattestDigest(receipt, null);
    receipt.change_set_digest = finalDigest; receipt.repair.final_change_set_digest = finalDigest; receipt.state = "VERIFYING"; receipt.updated_at = timestamp(options.now); await writeExecutorReceipt(options.stateDirectory, receipt);
    const request = { run_id: receipt.run_id, artifact_sha256: receipt.artifact_sha256, worktree_path: receipt.worktree_path, accepted_bundle_path: options.acceptedBundlePath, change_set_digest: finalDigest, changed_paths: effectiveExecutorChangedPaths(receipt), ...(options.signal ? { signal: options.signal } : {}) };
    const result = await options.verifier.verify(request); await reattestDigest(receipt, finalDigest);
    const evidence = boundedEvidence(result.evidence); await persistExecutorEvidence({ stateDirectory: options.stateDirectory, receipt, name: `verification-${receipt.verification.rounds + 1}`, bytes: evidence.bytes, expectedSha256: evidence.sha256 });
    receipt.verification.rounds += 1; receipt.verification.passed = result.passed; receipt.verification.change_set_digest = finalDigest; receipt.verification.evidence_sha256 = evidence.sha256; receipt.updated_at = timestamp(options.now); await writeExecutorReceipt(options.stateDirectory, receipt);
    if (!result.passed) return await failToWeb(receipt, options.stateDirectory, "EXECUTOR_VERIFICATION_FAILED", "Deterministic verification rejected the bounded adaptive repair.", options.now);
    receipt.repair.state = "VERIFIED"; receipt.updated_at = timestamp(options.now); await writeExecutorReceipt(options.stateDirectory, receipt);
  }
  if (receipt.repair?.state !== "VERIFIED" || receipt.repair.final_change_set_digest === null) throw new ExecutorError("EXECUTOR_REPAIR_INVALID", "Adaptive repair did not reach a verified final digest.");
  assertReadyEvidence(receipt); await reattestDigest(receipt, receipt.repair.final_change_set_digest); receipt.state = "READY_FOR_PUBLISH"; receipt.updated_at = timestamp(options.now); await writeExecutorReceipt(options.stateDirectory, receipt); return receipt;
}

export async function executeRegisteredWebPack(options: { runId: string; artifactSha256: string; stateDirectory: string; configPath: string; verifier: ExecutorVerifierPort; reviewer?: ExecutorReviewerPort; reviewStrategy?: ExecutorReviewStrategy; signal?: AbortSignal; now?: () => Date }): Promise<ExecutorReceipt> {
  const now = options.now ?? (() => new Date()); const identity = splitRunId(options.runId); const lock = await acquireExecutorLock(options.stateDirectory, identity.taskId, identity.taskBundleSha256, options.artifactSha256); let receipt: ExecutorReceipt | null = null;
  try {
    receipt = await readExecutorReceipt(options.stateDirectory, identity.taskId, identity.taskBundleSha256, options.artifactSha256);
    if (receipt?.state === "ESCALATE_TO_WEB" || receipt?.state === "FAILED") return receipt;
    const source = receipt ? await loadExecutorResumeSource({ runId: options.runId, artifactSha256: options.artifactSha256, stateDirectory: options.stateDirectory, configPath: options.configPath }) : await loadExecutorSource({ runId: options.runId, artifactSha256: options.artifactSha256, stateDirectory: options.stateDirectory, configPath: options.configPath });
    if (receipt) {
      assertReceiptAuthority(receipt, source); assertExecutorTransactionBoundToPack(receipt, source.pack); await attestExecutorTransactionBackups(options.stateDirectory, receipt); await attestPersistedExecutorGateEvidence(options.stateDirectory, receipt);
      if (options.reviewStrategy && receipt.review_strategy && receipt.review_strategy !== options.reviewStrategy) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Harness review strategy changed after execution started.");
      if (receipt.state === "READY_FOR_PUBLISH") { if (options.reviewStrategy && receipt.review_strategy !== options.reviewStrategy) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "READY Harness receipt does not match the requested review strategy."); assertReadyEvidence(receipt); await reattestDigest(receipt, receipt.change_set_digest); return receipt; }
      if (options.reviewer) assertNoAmbiguousReviewResume(receipt, options.reviewer); await attestExecutorResumeChangedPaths(receipt);
    }
    if (!receipt) receipt = await prepareExecutorTransaction({ stateDirectory: options.stateDirectory, runId: options.runId, taskId: identity.taskId, taskBundleSha256: identity.taskBundleSha256, artifactSha256: options.artifactSha256, pack: source.pack, repositoryId: source.trusted.runReceipt.repository_id, baseBranch: source.trusted.runReceipt.base_branch, baseCommit: source.trusted.runReceipt.base_commit, baseTreeSha: source.registration.repository.tree_sha, worktreePath: source.trusted.runReceipt.worktree_path, registrationManifestSha256: source.registration.manifest_sha256, now });
    const selectedKind = options.reviewer?.reviewer_kind; const selectedProfile = options.reviewer?.reviewer_profile;
    if ((selectedKind === undefined) !== (selectedProfile === undefined)) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Selected reviewer kind/profile must be supplied together.");
    if (options.reviewStrategy && receipt.review_strategy === undefined) {
      if (!canBindStrategy(receipt)) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Harness review strategy cannot be introduced after model-review authority exists.");
      if (options.reviewStrategy === "model") {
        if (!selectedKind || !selectedProfile) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Model-review Harness execution requires exactly one selected reviewer before durable strategy binding.");
        receipt.reviewer_selection = { kind: selectedKind, model: selectedProfile.model, reasoning_effort: selectedProfile.reasoning_effort };
      }
      receipt.review_strategy = options.reviewStrategy; receipt.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt);
    }
    const strategy: EffectiveReviewStrategy = receipt.review_strategy ?? options.reviewStrategy ?? "legacy";
    const resumingFinalWebRepair = strategy === "model" && receipt.repair?.reviewer === "web";
    if (strategy === "web" && options.reviewer) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Web-review Harness execution must not initialize a model reviewer.");
    if (strategy !== "web" && !options.reviewer && !resumingFinalWebRepair) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Model/legacy Harness execution requires a reviewer port unless resuming a sealed final-Web repair.");
    if (strategy === "model" && (!selectedKind || !selectedProfile) && !resumingFinalWebRepair) throw new ExecutorError("EXECUTOR_STATE_INVALID", "Model-review Harness execution requires exactly one selected reviewer except while completing sealed final-Web repair.");
    if (selectedKind && selectedProfile) {
      const persisted = receipt.reviewer_selection; if (persisted && (persisted.kind !== selectedKind || persisted.model !== selectedProfile.model || persisted.reasoning_effort !== selectedProfile.reasoning_effort)) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Selected reviewer changed after this executor run started.");
      if (!persisted) { receipt.reviewer_selection = { kind: selectedKind, model: selectedProfile.model, reasoning_effort: selectedProfile.reasoning_effort }; receipt.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt); }
    } else if (receipt.reviewer_selection && !resumingFinalWebRepair) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "A selected-review executor cannot resume without its reviewer port outside sealed final-Web repair.");

    if ((strategy === "model" || strategy === "web") && receipt.repair) {
      if (strategy === "web" && receipt.repair.reviewer !== "web") throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Web-review Harness repair authority must come from Web.");
      if (strategy === "model" && receipt.repair.reviewer !== "web" && receipt.repair.reviewer !== receipt.reviewer_selection?.kind) throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", "Model-review Harness repair authority is neither the frozen selected reviewer nor final Web authority.");
      return await completeAdaptiveRepair({ receipt, stateDirectory: options.stateDirectory, verifier: options.verifier, pack: source.pack, acceptedBundlePath: source.trusted.runReceipt.accepted_bundle_path, ...(options.signal ? { signal: options.signal } : {}), now });
    }
    if (["PREPARED", "APPLYING"].includes(receipt.state)) receipt = await applyExecutorTransaction({ stateDirectory: options.stateDirectory, receipt, pack: source.pack, now });
    if (!["APPLIED", "VERIFYING", "REVIEWING_TERRA", "REVIEWING_SOL"].includes(receipt.state)) throw new ExecutorError("EXECUTOR_STATE_INVALID", `Unexpected executor state '${receipt.state}'.`);
    const digest = await reattestDigest(receipt, receipt.change_set_digest); receipt.change_set_digest = digest; receipt.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt);
    const baseRequest = { run_id: receipt.run_id, artifact_sha256: receipt.artifact_sha256, worktree_path: receipt.worktree_path, accepted_bundle_path: source.trusted.runReceipt.accepted_bundle_path, change_set_digest: digest, changed_paths: receipt.operations.map((operation) => operation.path).sort(), ...(options.signal ? { signal: options.signal } : {}) };
    if (!receipt.verification.passed || receipt.verification.change_set_digest !== digest) {
      receipt.state = "VERIFYING"; receipt.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt); const result = await options.verifier.verify(baseRequest); await reattestDigest(receipt, digest); const evidence = boundedEvidence(result.evidence); await persistExecutorEvidence({ stateDirectory: options.stateDirectory, receipt, name: `verification-${receipt.verification.rounds + 1}`, bytes: evidence.bytes, expectedSha256: evidence.sha256 }); receipt.verification.rounds += 1; receipt.verification.passed = result.passed; receipt.verification.change_set_digest = digest; receipt.verification.evidence_sha256 = evidence.sha256; if (!result.passed) return await failToWeb(receipt, options.stateDirectory, "EXECUTOR_VERIFICATION_FAILED", "Deterministic verification rejected the exact registered Web result.", now); receipt.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt);
    }
    if (strategy === "web") { assertReadyEvidence(receipt); await reattestDigest(receipt, digest); receipt.state = "READY_FOR_PUBLISH"; receipt.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt); return receipt; }

    const reviewer = options.reviewer!; const contextSelection = selectSmartContext(source.pack, baseRequest.changed_paths); const runTerra = strategy === "legacy" ? selectedKind === undefined || selectedKind === "terra" : selectedKind === "terra"; const runSol = strategy === "legacy" ? selectedKind === undefined || selectedKind === "sol" : selectedKind === "sol";
    const reviewOne = async (kind: "terra" | "sol", prior: string[]): Promise<ExecutorReceipt | null> => {
      const gate = kind === "terra" ? receipt!.terra_review : receipt!.sol_review;
      if (gate.verdict === "APPROVE" && gate.change_set_digest === digest) return null;
      receipt!.state = kind === "terra" ? "REVIEWING_TERRA" : "REVIEWING_SOL"; receipt!.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt!); await reserveReviewTurn(receipt!, reviewer, options.stateDirectory, now);
      const result = await reviewer.review({ ...baseRequest, reviewer: kind, prior_evidence_sha256: prior, context_selection: contextSelection }); await reattestDigest(receipt!, digest); recordUsage(receipt!, result.usage); assertMeasuredUsageWithinBudget(receipt!, reviewer); receipt!.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt!);
      const evidence = boundedEvidence(result.evidence); await persistExecutorEvidence({ stateDirectory: options.stateDirectory, receipt: receipt!, name: `${kind}-${gate.rounds + 1}`, bytes: evidence.bytes, expectedSha256: evidence.sha256 }); gate.rounds += 1; gate.verdict = result.verdict; gate.change_set_digest = digest; gate.evidence_sha256 = evidence.sha256;
      if (result.verdict === "APPROVE") { receipt!.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt!); return null; }
      if (strategy === "model" && result.verdict === "REVISE" && result.repair_operations?.length) {
        receipt = await bindReviewerRepair({ stateDirectory: options.stateDirectory, receipt: receipt!, reviewer: kind, sourceChangeSetDigest: digest, sourceReviewEvidenceSha256: evidence.sha256, operations: result.repair_operations, now });
        return await completeAdaptiveRepair({ receipt, stateDirectory: options.stateDirectory, verifier: options.verifier, pack: source.pack, acceptedBundlePath: source.trusted.runReceipt.accepted_bundle_path, ...(options.signal ? { signal: options.signal } : {}), now });
      }
      return await failToWeb(receipt!, options.stateDirectory, "EXECUTOR_REVIEW_REJECTED", `${kind === "terra" ? "Terra" : "Sol"} review returned ${result.verdict}; no bounded adaptive repair authority was accepted.`, now);
    };
    if (runTerra) { const terminal = await reviewOne("terra", receipt.verification.evidence_sha256 ? [receipt.verification.evidence_sha256] : []); if (terminal) return terminal; }
    if (runSol) { const prior = strategy === "legacy" && selectedKind === undefined ? [receipt.verification.evidence_sha256, receipt.terra_review.evidence_sha256].filter((value): value is string => Boolean(value)) : [receipt.verification.evidence_sha256].filter((value): value is string => Boolean(value)); const terminal = await reviewOne("sol", prior); if (terminal) return terminal; }
    assertReadyEvidence(receipt); await reattestDigest(receipt, digest); receipt.state = "READY_FOR_PUBLISH"; receipt.updated_at = timestamp(now); await writeExecutorReceipt(options.stateDirectory, receipt); return receipt;
  } catch (error) {
    if (receipt && error instanceof ExecutorError && ["EXECUTOR_BUDGET_EXHAUSTED", "EXECUTOR_AMBIGUOUS_RECOVERY"].includes(error.code) && receipt.state !== "READY_FOR_PUBLISH") return await failTerminal(receipt, options.stateDirectory, error.code, error.message, now);
    if (receipt && error instanceof ExecutorError && !["READY_FOR_PUBLISH", "ESCALATE_TO_WEB", "FAILED"].includes(receipt.state)) return await failToWeb(receipt, options.stateDirectory, error.code, error.message, now);
    throw error;
  } finally { await releaseExecutorLock(lock); }
}
