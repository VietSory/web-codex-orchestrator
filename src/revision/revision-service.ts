import path from "node:path";
import { loadPhase4Config, readBundleJson, effectiveLimit } from "../execution/execution-config.js";
import { assertPhase4ExecutionContract } from "../execution/execution-validator.js";
import { snapshotBundle, assertBundleUnchanged } from "../execution/bundle-integrity.js";
import { calculateChangeSet } from "../execution/change-set.js";
import { enforcePathPolicy } from "../execution/path-policy.js";
import { verifyDeterministically } from "../verifier/verifier.js";
import type { VerificationSandbox } from "../verifier/contracts.js";
import type { AgentClient, AgentTurnResponse } from "../agent/contracts.js";
import { assessWithTerra, implementWithTerra } from "../agent/terra-implementer.js";
import { reviewWithTerra } from "../agent/terra-reviewer.js";
import { reviewWithSol } from "../agent/sol-reviewer.js";
import { BudgetTracker } from "../execution/budget.js";
import type { ReviewResult, ChangeSet, AgentImplementationResult } from "../execution/contracts.js";
import { ExecutionError } from "../execution/errors.js";
import { GitRunner } from "../git/git-runner.js";
import type { GitHubAttestationClient } from "../result-bundle/github-attestation.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { loadSealedRevisionSource } from "./revision-source.js";
import { resolveRevisionRoundPaths, prepareRevisionRoundPaths } from "./revision-paths.js";
import { acquireRevisionLock } from "./revision-lock.js";
import { readRevisionReceipt, writeRevisionReceipt, writeCanonicalRevisionArtifact, readCanonicalRevisionArtifact } from "./revision-store.js";
import { attestRevisionPullRequest } from "./revision-github-attestation.js";
import { attestRevisionGitBoundary, calculateApprovedRevisionSnapshot, publishRevision } from "./revision-git.js";
import { packageRevisionResultBundle } from "./revision-result-bundle.js";
import { loadAndVerifyResultBundle } from "../web-review/result-bundle-review-reader.js";
import { RevisionError, type RevisionReceipt, type RevisionErrorCode } from "./contracts.js";

export interface RevisionServiceOptions {
  runId: string;
  revisionRound: number;
  stateDirectory: string;
  configPath: string;
  agentClient: AgentClient;
  sandbox: VerificationSandbox;
  gitRunner: GitRunner;
  githubClient?: GitHubAttestationClient;
  signal?: AbortSignal;
  now?: () => Date;
  secrets?: string[];
}

function nowIso(now?: () => Date): string { return (now ? now() : new Date()).toISOString(); }
function recordUsage(budget: BudgetTracker, response: AgentTurnResponse): void { budget.recordTokens(response.usage?.input_tokens, response.usage?.output_tokens, response.usage?.cached_input_tokens ?? 0); }
function syncUsage(receipt: RevisionReceipt, budget: BudgetTracker): void {
  receipt.usage = {
    input_tokens: budget.usage.inputTokens,
    cached_input_tokens: budget.usage.cachedInputTokens,
    output_tokens: budget.usage.outputTokens,
    total_turns: budget.usage.totalTurns,
    implementation_iterations: budget.usage.implementationIterations,
    internal_review_rounds: budget.usage.internalReviewRounds,
    sol_review_rounds: budget.usage.solReviewRounds,
    started_at: receipt.usage.started_at,
  };
  receipt.implementer.iterations = budget.usage.implementationIterations;
  receipt.terra_review.rounds = budget.usage.internalReviewRounds;
  receipt.sol_review.rounds = budget.usage.solReviewRounds;
}
function mapExecutionError(error: unknown): RevisionError {
  if (error instanceof RevisionError) return error;
  if (error instanceof ExecutionError) {
    if (error.code === "BUDGET_EXHAUSTED") return new RevisionError("REVISION_BUDGET_EXHAUSTED", error.message);
    if (error.code === "INTERRUPTED") return new RevisionError("REVISION_INTERRUPTED", error.message);
    if (["PATH_POLICY_VIOLATION","FORBIDDEN_PATH_CHANGED","BINARY_CHANGE_NOT_ALLOWED","SYMLINK_CHANGE_NOT_ALLOWED","SUBMODULE_CHANGE_NOT_ALLOWED","SPECIAL_FILE_CHANGE_NOT_ALLOWED","CHANGE_LIMIT_EXCEEDED","AGENT_COMMITTED_CHANGES","AGENT_CHANGED_BRANCH"].includes(error.code)) return new RevisionError("REVISION_POLICY_BLOCKED", error.message);
    if (["VERIFIER_TIMEOUT","VERIFIER_MUTATED_SOURCE"].includes(error.code)) return new RevisionError("REVISION_VERIFICATION_FAILED", error.message);
  }
  return new RevisionError("REVISION_OPERATIONAL_ERROR", error instanceof Error ? error.message : String(error));
}
function reviewApproved(review: ReviewResult, digest: string): boolean {
  return review.verdict === "APPROVE" && review.reviewed_change_set_sha256 === digest && review.blocking_findings.length === 0 && review.scope_violations.length === 0 && review.unverified_acceptance.length === 0 && review.human_action === null;
}
function correctionPrompt(kind: string, review: ReviewResult | null, verificationSummary: string | null): string {
  return JSON.stringify({
    phase: "8",
    action: "bounded_revision_correction",
    source: kind,
    blocking_findings: review?.blocking_findings ?? [],
    scope_violations: review?.scope_violations ?? [],
    unverified_acceptance: review?.unverified_acceptance ?? [],
    verification_failure: verificationSummary,
    instruction: "Fix only these revision-regression/frozen-contract blockers. Do not redesign, expand scope, commit, push, use network, weaken tests, or edit execution contract files. Return READY_FOR_VERIFICATION when the bounded correction is complete.",
  });
}
function revisionPrompt(source: Awaited<ReturnType<typeof loadSealedRevisionSource>>, bundle: Awaited<ReturnType<typeof readBundleJson>>): string {
  return JSON.stringify({
    phase: "8",
    action: "same_pr_revision",
    sealed_revision_request: source.request,
    frozen_task_request: bundle.request,
    frozen_plan: bundle.plan,
    frozen_rules: bundle.rules,
    constraints: [
      "Fix every sealed finding and nothing outside the frozen contract.",
      "Do not commit, push, change branch, modify Git metadata, use network, execute payloads, or change task contract files.",
      "Preserve public behavior except where the sealed finding and frozen acceptance contract explicitly require a correction.",
    ],
  });
}
async function persist(receiptPath: string, receipt: RevisionReceipt, now?: () => Date): Promise<void> { receipt.updated_at = nowIso(now); await writeRevisionReceipt(receiptPath, receipt); }

export async function reviseRun(options: RevisionServiceOptions): Promise<RevisionReceipt> {
  const { runId, revisionRound, stateDirectory, configPath, agentClient, sandbox, gitRunner, githubClient, signal, now } = options;
  if (!Number.isInteger(revisionRound) || revisionRound < 1 || revisionRound > 3) throw new RevisionError("REVISION_REQUEST_INVALID", "Revision round must be 1..3.");
  const paths = resolveRevisionRoundPaths(stateDirectory, runId, revisionRound);
  await prepareRevisionRoundPaths(stateDirectory, paths);
  const lock = await acquireRevisionLock(paths.lockPath);
  let receipt: RevisionReceipt | null = null;

  try {
    const source = await loadSealedRevisionSource(stateDirectory, runId, revisionRound);
    const runContext = await resolveTrustedRunContext(runId, stateDirectory, configPath);
    const runReceipt = runContext.runReceipt;
    if (!runReceipt.worktree_path || !runReceipt.accepted_bundle_path || !runReceipt.repository_path || !runReceipt.remote) throw new RevisionError("REVISION_HISTORY_INVALID", "Canonical Phase 3 run receipt lacks worktree/bundle/repository/remote bindings.");
    const config = await loadPhase4Config(configPath).catch((error) => { throw new RevisionError("REVISION_CONFIG_INVALID", error instanceof Error ? error.message : String(error)); });
    if (!config.publish) throw new RevisionError("REVISION_CONFIG_INVALID", "Trusted publish configuration is required for Phase 8.");
    const acceptedBundlePath = path.resolve(runReceipt.accepted_bundle_path);
    const bundleSnapshot = await snapshotBundle(acceptedBundlePath).catch((error) => { throw new RevisionError("REVISION_BUNDLE_MUTATED", error instanceof Error ? error.message : String(error)); });
    const bundle = await readBundleJson(acceptedBundlePath).catch((error) => { throw new RevisionError("REVISION_BUNDLE_MUTATED", error instanceof Error ? error.message : String(error)); });
    const contract = assertPhase4ExecutionContract(bundle.manifest);
    if (!contract.delivery || !contract.git_policy) throw new RevisionError("REVISION_CONFIG_INVALID", "Frozen task delivery/git policy is incomplete.");
    if (contract.repository.id !== runReceipt.repository_id || contract.delivery.remote !== runReceipt.remote) throw new RevisionError("REVISION_HISTORY_INVALID", "Frozen delivery contract does not match the canonical run receipt.");
    if (contract.repository.base_commit !== source.previousResultBundle.receipt.base_commit) throw new RevisionError("REVISION_SPEC_DRIFT", "Original base commit changed across the frozen contract/result chain.");
    if (contract.delivery.branch_name !== source.previousResultBundle.receipt.pull_request.head_branch || contract.delivery.base_branch !== source.previousResultBundle.receipt.pull_request.base_branch) throw new RevisionError("REVISION_BRANCH_DRIFT", "Frozen delivery branch identity changed across Result Bundles.");

    const existing = await readRevisionReceipt(stateDirectory, paths.receiptPath);
    if (existing?.state === "RESULT_READY") {
      if (existing.run_id !== runId || existing.revision_round !== revisionRound || existing.revision_request_sha256 !== source.requestSha256) throw new RevisionError("REVISION_STATE_INVALID", "Existing RESULT_READY receipt does not bind this sealed revision request.");
      const verified = await loadAndVerifyResultBundle(stateDirectory, runId, revisionRound + 1);
      if (verified.receipt.archive_sha256 !== existing.result_bundle_sha256 || verified.receipt.manifest_sha256 !== existing.result_manifest_sha256) throw new RevisionError("REVISION_RESULT_FAILED", "Existing revision Result Bundle no longer matches the completed receipt.");
      return existing;
    }

    // First-round Git/PR preflight happens only before any agent mutation. On a
    // resumed dirty worktree the persisted receipt and exact refs binding are authority.
    let boundary;
    if (!existing) {
      boundary = await attestRevisionGitBoundary({ worktreePath:path.resolve(runReceipt.worktree_path), branchName:contract.delivery.branch_name, remoteName:contract.delivery.remote, expectedRemoteUrls:runContext.resolvedRepo.expected_remote_urls, previousHeadSha:source.request.previous_pr_head_sha, runner:gitRunner });
      const baseline = await calculateChangeSet({ worktreePath:boundary.worktreePath, baseCommit:source.request.previous_pr_head_sha, branchName:contract.delivery.branch_name, runner:gitRunner, allowedGeneratedPaths:config.verification.allowed_generated_paths });
      if (baseline.entries.length !== 0) throw new RevisionError("REVISION_WORKTREE_DIRTY", "Revision baseline must contain no uncommitted changes.");
      boundary.initialRefsSha256 = baseline.refs_sha256 ?? "";
      if (!/^[a-f0-9]{64}$/.test(boundary.initialRefsSha256)) throw new RevisionError("REVISION_STATE_INVALID", "Revision baseline refs digest is unavailable.");
      await attestRevisionPullRequest({ expected:{ pullRequestUrl:source.previousResultBundle.receipt.pull_request.url, pullRequestNumber:source.request.pull_request_number, headBranch:contract.delivery.branch_name, headSha:source.request.previous_pr_head_sha, baseBranch:contract.delivery.base_branch, baseSha:source.previousResultBundle.receipt.base_commit }, config, githubClient });
      const created = nowIso(now);
      receipt = {
        phase_version:"1.0", run_id:runId, revision_round:revisionRound, state:"READY_TO_REVISE", spec_set_sha256:source.request.spec_set_sha256, revision_request_sha256:source.requestSha256,
        previous_result_bundle_sha256:source.request.previous_result_bundle_sha256, previous_result_receipt_sha256:source.previousResultBundle.phase6ReceiptSha256, previous_verdict_sha256:source.request.previous_verdict_sha256,
        previous_published_commit_sha:source.request.previous_published_commit_sha, previous_pr_head_sha:source.request.previous_pr_head_sha, pull_request_number:source.request.pull_request_number,
        branch_name:contract.delivery.branch_name, base_branch:contract.delivery.base_branch, worktree_path:boundary.worktreePath, initial_refs_sha256:boundary.initialRefsSha256,
        implementer:{ model:config.agents.implementer.model, reasoning_effort:config.agents.implementer.reasoning_effort, thread_id:null, iterations:0 },
        verification:{ rounds:0, required_commands_passed:false, verified_change_set_sha256:null, commands:[] },
        terra_review:{ model:config.agents.internal_reviewer.model, reasoning_effort:config.agents.internal_reviewer.reasoning_effort, rounds:0, thread_ids:[], verdict:null, reviewed_change_set_sha256:null },
        sol_review:{ model:config.agents.final_reviewer.model, reasoning_effort:config.agents.final_reviewer.reasoning_effort, rounds:0, thread_ids:[], verdict:null, reviewed_change_set_sha256:null },
        usage:{ input_tokens:0,cached_input_tokens:0,output_tokens:0,total_turns:0,implementation_iterations:0,internal_review_rounds:0,sol_review_rounds:0,started_at:created },
        revision_change_set_sha256:null, revision_paths:[], approved_snapshot_sha256:null, new_published_commit_sha:null, remote_branch_sha:null, result_bundle_sha256:null, result_manifest_sha256:null, next_review_round:revisionRound+1,
        errors:[], created_at:created, updated_at:created, completed_at:null,
      };
      await writeCanonicalRevisionArtifact(paths.requestPath, source.requestBuffer);
      await persist(paths.receiptPath, receipt, now);
    } else {
      receipt = existing;
      if (receipt.run_id !== runId || receipt.revision_round !== revisionRound || receipt.revision_request_sha256 !== source.requestSha256 || receipt.previous_pr_head_sha !== source.request.previous_pr_head_sha || receipt.spec_set_sha256 !== source.request.spec_set_sha256) throw new RevisionError("REVISION_STATE_INVALID", "Persisted revision receipt does not bind the sealed authority chain.");
      boundary = { worktreePath:receipt.worktree_path, branchName:receipt.branch_name, remoteName:contract.delivery.remote, remoteUrl:runReceipt.remote_url ?? "", previousHeadSha:receipt.previous_pr_head_sha, initialRefsSha256:receipt.initial_refs_sha256 };
    }

    const budget = new BudgetTracker(config.agents.limits, Date.parse(receipt.usage.started_at), {
      implementationIterations:receipt.usage.implementation_iterations, internalReviewRounds:receipt.usage.internal_review_rounds, solReviewRounds:receipt.usage.sol_review_rounds, totalTurns:receipt.usage.total_turns,
      inputTokens:receipt.usage.input_tokens, cachedInputTokens:receipt.usage.cached_input_tokens, outputTokens:receipt.usage.output_tokens,
    });
    await agentClient.checkAvailability(); if (sandbox.checkAvailability) await sandbox.checkAvailability();
    if (signal?.aborted) throw new RevisionError("REVISION_INTERRUPTED", "Revision was cancelled before execution.");

    const maxChanged = effectiveLimit(config.verification.maximum_changed_files ?? contract.limits.max_changed_files, contract.limits.max_changed_files);
    const maxDiff = effectiveLimit(config.verification.maximum_diff_lines ?? contract.limits.max_diff_lines, contract.limits.max_diff_lines);
    const policy = async (changeSet: ChangeSet) => {
      if (changeSet.entries.some((entry) => entry.change_type === "renamed")) throw new RevisionError("REVISION_POLICY_BLOCKED", "Phase 8 revision publication does not accept rename semantics; use explicit add/delete within frozen paths.");
      await enforcePathPolicy({ worktreePath:receipt!.worktree_path, allowedPaths:contract.allowed_paths, forbiddenPaths:contract.forbidden_paths, maximumChangedFiles:maxChanged, maximumDiffLines:maxDiff, allowedGeneratedPaths:config.verification.allowed_generated_paths, maximumFileBytes:config.verification.maximum_file_bytes, expectedRefsSha256:receipt!.initial_refs_sha256 }, changeSet);
      if (changeSet.entries.length === 0) throw new RevisionError("REVISION_POLICY_BLOCKED", "Revision request produced no repository changes.");
    };

    let latestImplementation: AgentImplementationResult | null = null;
    let currentChangeSet: ChangeSet | null = null;
    let terraReview: ReviewResult | null = null;
    let solReview: ReviewResult | null = null;

    // If this is a fresh receipt, start with a read-only assessment then one implementation turn.
    if (receipt.state === "READY_TO_REVISE") {
      receipt.state="IMPLEMENTING"; await persist(paths.receiptPath, receipt, now);
      budget.beginAssessment();
      const assessed = await assessWithTerra(agentClient,{ model:config.agents.implementer.model, reasoning_effort:config.agents.implementer.reasoning_effort, prompt:revisionPrompt(source,bundle), threadId:receipt.implementer.thread_id ?? undefined, workspacePath:receipt.worktree_path, acceptedBundlePath, signal });
      recordUsage(budget, assessed.response); receipt.implementer.thread_id=assessed.response.thread_id; syncUsage(receipt,budget); await persist(paths.receiptPath,receipt,now);
      if (assessed.assessment.status !== "COMPATIBLE" || assessed.assessment.human_action) throw new RevisionError("REVISION_AGENT_FAILED", `Revision assessment did not authorize bounded implementation: ${assessed.assessment.status}.`);
      budget.beginImplementation();
      const implemented = await implementWithTerra(agentClient,{ model:config.agents.implementer.model, reasoning_effort:config.agents.implementer.reasoning_effort, prompt:revisionPrompt(source,bundle), threadId:receipt.implementer.thread_id!, workspacePath:receipt.worktree_path, acceptedBundlePath, signal });
      recordUsage(budget, implemented.response); latestImplementation=implemented.implementation; syncUsage(receipt,budget); await persist(paths.receiptPath,receipt,now);
      if (implemented.implementation.status !== "READY_FOR_VERIFICATION" || implemented.implementation.human_action) throw new RevisionError("REVISION_AGENT_FAILED", `Revision implementer stopped with ${implemented.implementation.status}.`);
    }

    // If a crash happened after a commit, jump directly to publication recovery.
    const observedHead = (await gitRunner.run(["rev-parse","HEAD"],receipt.worktree_path)).stdout.trim();
    if (observedHead !== receipt.previous_pr_head_sha && receipt.state !== "READY_FOR_PUBLISH" && receipt.state !== "COMMITTED" && receipt.state !== "PUSHED") throw new RevisionError("REVISION_HEAD_DRIFT", "Worktree contains a commit before revision publication authority was persisted.");

    while (!["READY_FOR_PUBLISH","COMMITTED","PUSHED"].includes(receipt.state)) {
      if (signal?.aborted) throw new RevisionError("REVISION_INTERRUPTED", "Revision was cancelled.");
      receipt.state="POLICY_CHECKING"; await persist(paths.receiptPath,receipt,now);
      currentChangeSet=await calculateChangeSet({ worktreePath:receipt.worktree_path, baseCommit:receipt.previous_pr_head_sha, branchName:receipt.branch_name, runner:gitRunner, allowedGeneratedPaths:config.verification.allowed_generated_paths }); await policy(currentChangeSet);
      receipt.revision_change_set_sha256=currentChangeSet.change_set_sha256; receipt.revision_paths=currentChangeSet.entries.map((entry)=>entry.path).sort();

      receipt.state="VERIFYING"; receipt.verification.rounds+=1; await persist(paths.receiptPath,receipt,now);
      let verification;
      try {
        verification=await verifyDeterministically({ worktreePath:receipt.worktree_path, baseCommit:receipt.previous_pr_head_sha, branchName:receipt.branch_name, validation:bundle.validation, policy:{ allowed_executables:config.verification.allowed_executables, allowed_environment_keys:config.verification.allowed_environment_keys, maximum_command_seconds:config.verification.maximum_command_seconds, maximum_output_bytes:config.verification.maximum_output_bytes, allowed_generated_paths:config.verification.allowed_generated_paths }, sandbox, runner:gitRunner, signal, expectedRefsSha256:receipt.initial_refs_sha256, now });
      } catch (error) {
        if (error instanceof ExecutionError && ["VERIFIER_TIMEOUT","VERIFICATION_FAILED"].includes(error.code)) verification=null; else throw error;
      }
      if (!verification || !verification.required_commands_passed) {
        budget.beginImplementation();
        const corrected=await implementWithTerra(agentClient,{ model:config.agents.implementer.model, reasoning_effort:config.agents.implementer.reasoning_effort, prompt:correctionPrompt("deterministic_verifier",null,"Required deterministic verification did not pass."), threadId:receipt.implementer.thread_id!, workspacePath:receipt.worktree_path, acceptedBundlePath, signal });
        recordUsage(budget,corrected.response); latestImplementation=corrected.implementation; syncUsage(receipt,budget); await persist(paths.receiptPath,receipt,now);
        if (corrected.implementation.status!=="READY_FOR_VERIFICATION" || corrected.implementation.human_action) throw new RevisionError("REVISION_VERIFICATION_FAILED","Verifier correction could not remain within the frozen revision contract.");
        continue;
      }
      await policy(verification.changeSet);
      if (verification.changeSet.change_set_sha256!==currentChangeSet.change_set_sha256) { currentChangeSet=verification.changeSet; receipt.revision_change_set_sha256=currentChangeSet.change_set_sha256; receipt.revision_paths=currentChangeSet.entries.map((entry)=>entry.path).sort(); }
      receipt.verification.required_commands_passed=true; receipt.verification.verified_change_set_sha256=currentChangeSet.change_set_sha256; receipt.verification.commands=verification.commands;

      receipt.state="TERRA_REVIEWING"; await persist(paths.receiptPath,receipt,now); budget.beginInternalReview();
      const terra=await reviewWithTerra(agentClient,{ model:config.agents.internal_reviewer.model, reasoning_effort:config.agents.internal_reviewer.reasoning_effort, prompt:JSON.stringify({ phase:"8", role:"independent_revision_review", sealed_revision_request:source.request, exact_change_set_sha256:currentChangeSet.change_set_sha256, instruction:"Review the exact revision against the frozen task contract. APPROVE only if all sealed findings are resolved, required acceptance remains satisfied, scope is unchanged, and evidence is sufficient." }), threadId:undefined, workspacePath:receipt.worktree_path, acceptedBundlePath, signal });
      recordUsage(budget,terra.response); terraReview=terra.review; receipt.terra_review.thread_ids.push(terra.threadId); receipt.terra_review.verdict=terra.review.verdict; receipt.terra_review.reviewed_change_set_sha256=terra.review.reviewed_change_set_sha256; syncUsage(receipt,budget); await persist(paths.receiptPath,receipt,now);
      if (!reviewApproved(terra.review,currentChangeSet.change_set_sha256)) {
        if (terra.review.verdict!=="REVISE" || terra.review.human_action) throw new RevisionError("REVISION_TERRA_REVIEW_FAILED",`Terra revision review returned ${terra.review.verdict}.`);
        budget.beginImplementation(); const corrected=await implementWithTerra(agentClient,{ model:config.agents.implementer.model, reasoning_effort:config.agents.implementer.reasoning_effort, prompt:correctionPrompt("terra_review",terra.review,null), threadId:receipt.implementer.thread_id!, workspacePath:receipt.worktree_path, acceptedBundlePath, signal }); recordUsage(budget,corrected.response); latestImplementation=corrected.implementation; syncUsage(receipt,budget); await persist(paths.receiptPath,receipt,now); if (corrected.implementation.status!=="READY_FOR_VERIFICATION"||corrected.implementation.human_action) throw new RevisionError("REVISION_TERRA_REVIEW_FAILED","Terra correction left the bounded revision contract."); receipt.verification.required_commands_passed=false; receipt.terra_review.verdict=null; receipt.sol_review.verdict=null; continue;
      }

      receipt.state="SOL_REVIEWING"; await persist(paths.receiptPath,receipt,now); budget.beginSolReview();
      const sol=await reviewWithSol(agentClient,{ model:config.agents.final_reviewer.model, reasoning_effort:config.agents.final_reviewer.reasoning_effort, prompt:JSON.stringify({ phase:"8", role:"adversarial_revision_review", sealed_revision_request:source.request, exact_change_set_sha256:currentChangeSet.change_set_sha256, instruction:"Adversarially review the exact revision. APPROVE only if deterministic verification and frozen-contract compliance are complete with no hidden regression, scope expansion, or weakened test/evidence." }), threadId:undefined, workspacePath:receipt.worktree_path, acceptedBundlePath, signal });
      recordUsage(budget,sol.response); solReview=sol.review; receipt.sol_review.thread_ids.push(sol.threadId); receipt.sol_review.verdict=sol.review.verdict; receipt.sol_review.reviewed_change_set_sha256=sol.review.reviewed_change_set_sha256; syncUsage(receipt,budget); await persist(paths.receiptPath,receipt,now);
      if (!reviewApproved(sol.review,currentChangeSet.change_set_sha256)) {
        if (sol.review.verdict!=="REVISE" || sol.review.human_action) throw new RevisionError("REVISION_SOL_REVIEW_FAILED",`Sol revision review returned ${sol.review.verdict}.`);
        budget.beginImplementation(); const corrected=await implementWithTerra(agentClient,{ model:config.agents.implementer.model, reasoning_effort:config.agents.implementer.reasoning_effort, prompt:correctionPrompt("sol_review",sol.review,null), threadId:receipt.implementer.thread_id!, workspacePath:receipt.worktree_path, acceptedBundlePath, signal }); recordUsage(budget,corrected.response); latestImplementation=corrected.implementation; syncUsage(receipt,budget); await persist(paths.receiptPath,receipt,now); if (corrected.implementation.status!=="READY_FOR_VERIFICATION"||corrected.implementation.human_action) throw new RevisionError("REVISION_SOL_REVIEW_FAILED","Sol correction left the bounded revision contract."); receipt.verification.required_commands_passed=false; receipt.terra_review.verdict=null; receipt.sol_review.verdict=null; continue;
      }

      await assertBundleUnchanged(acceptedBundlePath,bundleSnapshot).catch((error)=>{throw new RevisionError("REVISION_BUNDLE_MUTATED",error instanceof Error?error.message:String(error));});
      const finalSet=await calculateChangeSet({ worktreePath:receipt.worktree_path, baseCommit:receipt.previous_pr_head_sha, branchName:receipt.branch_name, runner:gitRunner, allowedGeneratedPaths:config.verification.allowed_generated_paths }); await policy(finalSet);
      if (finalSet.change_set_sha256!==receipt.verification.verified_change_set_sha256 || finalSet.change_set_sha256!==receipt.terra_review.reviewed_change_set_sha256 || finalSet.change_set_sha256!==receipt.sol_review.reviewed_change_set_sha256) throw new RevisionError("REVISION_POLICY_BLOCKED","Revision changed after verification/review approval.");
      receipt.revision_change_set_sha256=finalSet.change_set_sha256; receipt.revision_paths=finalSet.entries.map((entry)=>entry.path).sort(); receipt.approved_snapshot_sha256=await calculateApprovedRevisionSnapshot({ runner:gitRunner, worktreePath:receipt.worktree_path, approvedPaths:receipt.revision_paths }); receipt.state="READY_FOR_PUBLISH"; await persist(paths.receiptPath,receipt,now);
    }

    // Persist immutable final agent evidence before publication; compare-and-adopt
    // makes exact retries deterministic.
    if (!latestImplementation) latestImplementation={ status:"READY_FOR_VERIFICATION", summary:"Recovered approved revision state.", changed_files_claimed:receipt.revision_paths, acceptance_evidence:[], tests_added_or_changed:[], unresolved_issues:[], human_action:null };
    await writeCanonicalRevisionArtifact(paths.implementationPath,latestImplementation);
    await writeCanonicalRevisionArtifact(paths.verificationPath,receipt.verification);
    await writeCanonicalRevisionArtifact(paths.terraReviewPath,terraReview ?? receipt.terra_review);
    await writeCanonicalRevisionArtifact(paths.solReviewPath,solReview ?? receipt.sol_review);

    if (receipt.state==="READY_FOR_PUBLISH" || receipt.state==="COMMITTED") {
      const published=await publishRevision({ worktreePath:receipt.worktree_path, branchName:receipt.branch_name, remoteName:contract.delivery.remote, remoteUrl:boundary.remoteUrl, previousHeadSha:receipt.previous_pr_head_sha, initialRefsSha256:receipt.initial_refs_sha256, approvedPaths:receipt.revision_paths, approvedSnapshotSha256:receipt.approved_snapshot_sha256!, commitMessage:`wco: revision ${revisionRound} for ${bundle.manifest.task_id}` },gitRunner);
      receipt.new_published_commit_sha=published.new_commit_sha; receipt.remote_branch_sha=published.remote_branch_sha; receipt.state="PUSHED"; await persist(paths.receiptPath,receipt,now);
    }

    const finalPr=await attestRevisionPullRequest({ expected:{ pullRequestUrl:source.previousResultBundle.receipt.pull_request.url, pullRequestNumber:receipt.pull_request_number, headBranch:receipt.branch_name, headSha:receipt.new_published_commit_sha!, baseBranch:receipt.base_branch, baseSha:source.previousResultBundle.receipt.base_commit }, config, githubClient });
    const publishArtifact={ run_id:runId, revision_round:revisionRound, previous_head_sha:receipt.previous_pr_head_sha, new_commit_sha:receipt.new_published_commit_sha, remote_branch_sha:receipt.remote_branch_sha, branch_name:receipt.branch_name, pull_request_number:receipt.pull_request_number, same_pull_request:true, force_push:false, merged:false };
    const publishWritten=await writeCanonicalRevisionArtifact(paths.publishPath,publishArtifact);
    const revisionEvidence={ run_id:runId, revision_round:revisionRound, state:"PUSHED", sealed_revision_request_sha256:source.requestSha256, spec_set_sha256:receipt.spec_set_sha256, previous_result_bundle_sha256:receipt.previous_result_bundle_sha256, previous_result_receipt_sha256:receipt.previous_result_receipt_sha256, previous_verdict_sha256:receipt.previous_verdict_sha256, previous_head_sha:receipt.previous_pr_head_sha, revision_change_set_sha256:receipt.revision_change_set_sha256, revision_paths:receipt.revision_paths, approved_snapshot_sha256:receipt.approved_snapshot_sha256, verification:receipt.verification, terra_review:receipt.terra_review, sol_review:receipt.sol_review, usage:receipt.usage, published_commit_sha:receipt.new_published_commit_sha, remote_branch_sha:receipt.remote_branch_sha };
    const revisionEvidenceWritten=await writeCanonicalRevisionArtifact(paths.evidencePath,revisionEvidence);

    const resultReceipt=await packageRevisionResultBundle({ stateDirectory, paths, source, revisionReceipt:receipt, revisionEvidence, revisionEvidenceSha256:revisionEvidenceWritten.sha256, publishEvidence:publishArtifact, publishEvidenceSha256:publishWritten.sha256, prAttestation:finalPr, acceptedBundlePath, originalBaseCommit:contract.repository.base_commit, worktreePath:receipt.worktree_path, runner:gitRunner, limits:config.result_bundle, secrets:options.secrets, now });
    receipt.result_bundle_sha256=resultReceipt.archive_sha256; receipt.result_manifest_sha256=resultReceipt.manifest_sha256; receipt.state="RESULT_READY"; receipt.completed_at=nowIso(now); await persist(paths.receiptPath,receipt,now);
    return receipt;
  } catch (rawError) {
    const error=mapExecutionError(rawError);
    if (receipt) {
      receipt.state=error.code==="REVISION_INTERRUPTED"||error.code==="REVISION_OPERATIONAL_ERROR"?"RETRYABLE":"BLOCKED";
      receipt.errors=[...receipt.errors.slice(-31),{code:error.code,message:error.message.slice(0,8192)}]; receipt.updated_at=nowIso(now); await writeRevisionReceipt(paths.receiptPath,receipt).catch(()=>undefined);
    }
    throw error;
  } finally { await lock.release(); }
}

export async function getRevisionStatus(stateDirectory:string, runId:string, revisionRound?:number):Promise<RevisionReceipt|null>{
  if (revisionRound!==undefined) return readRevisionReceipt(stateDirectory,resolveRevisionRoundPaths(stateDirectory,runId,revisionRound).receiptPath);
  for(let round=3;round>=1;round--){const found=await readRevisionReceipt(stateDirectory,resolveRevisionRoundPaths(stateDirectory,runId,round).receiptPath);if(found)return found;}return null;
}
