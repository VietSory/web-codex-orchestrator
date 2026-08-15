import fs from "node:fs/promises";
import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { calculateChangeSet } from "../execution/change-set.js";
import { readExecutorReceipt } from "../executor/store.js";
import { executorPaths } from "../executor/paths.js";
import { loadPhase4Config } from "../execution/execution-config.js";
import { GitRunner } from "../git/git-runner.js";
import { preparePublishGitSecurity } from "../publish/publish-auth.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { BubblewrapVerificationSandbox } from "../verifier/bubblewrap-sandbox.js";
import { loadSealedRevisionSource } from "../revision/revision-source.js";
import { reviseRun } from "../revision/revision-service.js";
import type { RevisionReceipt } from "../revision/contracts.js";
import { resolveRevisionRoundPaths, prepareRevisionRoundPaths } from "../revision/revision-paths.js";
import { readRevisionReceipt, writeCanonicalRevisionArtifact, writeRevisionReceipt } from "../revision/revision-store.js";
import { attestRevisionPullRequest } from "../revision/revision-github-attestation.js";
import { calculateApprovedRevisionSnapshot } from "../revision/revision-git.js";
import { packageRevisionResultBundle } from "../revision/revision-result-bundle.js";
import { getWebReviewStatus } from "../web-review/web-review-service.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { readSelectedArtifact } from "./artifact-binding.js";
import { openDraftPullRequestForExecutorSnapshot } from "./draft-pr.js";
import { publishReadyExecutorSnapshot } from "./p10-publish.js";
import { OrchestrationError } from "./contracts.js";
import { readExactVerificationCommands } from "./verification-evidence.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

export interface RevisionOrchestrationAuthority {
  revisionRound: number;
  revisionRequestSha256: string;
  verdictSha256: string;
  decisionEventSha256: string;
  publishedCommitSha: string;
  pullRequestNumber: number;
  freshAttestedHeadSha: string;
}

export function revisionOrchestrationPayload(authority: RevisionOrchestrationAuthority): Record<string, unknown> {
  return {
    review_round: authority.revisionRound,
    verdict_sha256: authority.verdictSha256,
    revision_request_sha256: authority.revisionRequestSha256,
    decision_event_sha256: authority.decisionEventSha256,
    published_commit_sha: authority.publishedCommitSha,
    pull_request_number: authority.pullRequestNumber,
  };
}

export function revisionOrchestrationUsage(receipt: RevisionReceipt): { model_turns: number; input_tokens: number; output_tokens: number } {
  return {
    model_turns: receipt.usage.total_turns,
    input_tokens: receipt.usage.input_tokens,
    output_tokens: receipt.usage.output_tokens,
  };
}

export function assertRevisionResultForOrchestration(
  runId: string,
  receipt: RevisionReceipt,
  authority: RevisionOrchestrationAuthority,
): void {
  if (
    receipt.run_id !== runId ||
    receipt.revision_round !== authority.revisionRound ||
    receipt.state !== "RESULT_READY" ||
    receipt.previous_verdict_sha256 !== authority.verdictSha256 ||
    receipt.revision_request_sha256 !== authority.revisionRequestSha256 ||
    receipt.previous_pr_head_sha !== authority.freshAttestedHeadSha ||
    receipt.pull_request_number !== authority.pullRequestNumber ||
    receipt.new_published_commit_sha === null ||
    receipt.remote_branch_sha !== receipt.new_published_commit_sha ||
    receipt.result_bundle_sha256 === null || !SHA256.test(receipt.result_bundle_sha256) ||
    receipt.result_manifest_sha256 === null || !SHA256.test(receipt.result_manifest_sha256) ||
    receipt.next_review_round !== authority.revisionRound + 1
  ) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_INCOMPLETE", "Revision did not produce an exact same-PR fast-forward Result Bundle bound to the sealed Web request.");
  }
}

export async function attestRevisionAuthorityForOrchestration(options: {
  runId: string;
  stateDirectory: string;
}): Promise<RevisionOrchestrationAuthority> {
  const review = await getWebReviewStatus({ runId: options.runId, stateDirectory: options.stateDirectory });
  if (!review || review.run_id !== options.runId || review.state !== "REVISION_REQUESTED") {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "No terminal REVISION_REQUESTED Web Review receipt authorizes a revision.");
  }
  if (!Number.isInteger(review.review_round) || review.review_round < 1 || review.review_round > 3) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Revision-requested review round is outside the supported 1..3 revision window.");
  }
  if (!review.revision_request_sha256 || !SHA256.test(review.revision_request_sha256) || !review.verdict_sha256 || !SHA256.test(review.verdict_sha256) || !review.decision_event_sha256 || !SHA256.test(review.decision_event_sha256)) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Web Review revision authority is missing sealed SHA-256 bindings.");
  }
  if (!review.fresh_attested_head_sha || !GIT_SHA.test(review.fresh_attested_head_sha) || review.fresh_attested_head_sha !== review.published_commit_sha || !GIT_SHA.test(review.published_commit_sha)) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Web Review revision authority is not bound to the freshly attested published head.");
  }
  if (!Number.isInteger(review.pull_request_number) || review.pull_request_number < 1) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Web Review revision authority has an invalid pull request number.");
  }

  const source = await loadSealedRevisionSource(options.stateDirectory, options.runId, review.review_round);
  if (
    source.requestSha256 !== review.revision_request_sha256 ||
    source.request.previous_verdict_sha256 !== review.verdict_sha256 ||
    source.request.previous_published_commit_sha !== review.published_commit_sha ||
    source.request.previous_pr_head_sha !== review.fresh_attested_head_sha ||
    source.request.pull_request_number !== review.pull_request_number
  ) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Sealed Phase 7 revision request no longer matches its terminal Web Review authority.");
  }

  return {
    revisionRound: review.review_round,
    revisionRequestSha256: source.requestSha256,
    verdictSha256: review.verdict_sha256,
    decisionEventSha256: review.decision_event_sha256,
    publishedCommitSha: review.published_commit_sha,
    pullRequestNumber: review.pull_request_number,
    freshAttestedHeadSha: review.fresh_attested_head_sha,
  };
}

async function prepareRuntimeDirectory(stateDirectory: string): Promise<string> {
  const runtime = path.resolve(stateDirectory, "revision-runtime");
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(runtime);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(runtime) !== runtime) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision runtime directory must be a canonical real directory.");
  const hooks = path.join(runtime, "empty-hooks");
  await fs.mkdir(hooks, { mode: 0o700 }).catch(async (error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const hookStat = await fs.lstat(hooks);
  if (hookStat.isSymbolicLink() || !hookStat.isDirectory()) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision empty-hooks path is unsafe.");
  const config = path.join(runtime, "empty-config");
  try { await fs.writeFile(config, "", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await fs.lstat(config);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== 0) throw new OrchestrationError("ORCHESTRATION_REVISION_STATE_UNSAFE", "Revision empty-config file is unsafe.");
  }
  return runtime;
}

function collectSecrets(config: Awaited<ReturnType<typeof loadPhase4Config>>): string[] {
  const keys = new Set<string>();
  if (config.publish?.authentication.mode === "https_token") keys.add(config.publish.authentication.token_environment_key);
  if (config.github_pull_request?.authentication.mode === "https_token") keys.add(config.github_pull_request.authentication.token_environment_key);
  return [...keys].map((key) => process.env[key]).filter((value): value is string => typeof value === "string" && value.length >= 8);
}

function assertHarnessRevisionCheckpoint(receipt: RevisionReceipt, options: { runId: string; revisionRound: number; authority: RevisionOrchestrationAuthority; finalDigest: string }): void {
  if (
    receipt.run_id !== options.runId || receipt.revision_round !== options.revisionRound ||
    receipt.revision_request_sha256 !== options.authority.revisionRequestSha256 ||
    receipt.previous_verdict_sha256 !== options.authority.verdictSha256 ||
    receipt.previous_pr_head_sha !== options.authority.freshAttestedHeadSha ||
    receipt.pull_request_number !== options.authority.pullRequestNumber ||
    !["READY_FOR_PUBLISH", "PUSHED", "RESULT_READY"].includes(receipt.state) ||
    receipt.usage.total_turns !== 0 || receipt.usage.input_tokens !== 0 || receipt.usage.output_tokens !== 0 ||
    receipt.implementer.model !== "web-bounded-repair" ||
    receipt.verification.required_commands_passed !== true || receipt.verification.verified_change_set_sha256 !== options.finalDigest
  ) throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_RECOVERY_INVALID", "Durable Harness Web revision checkpoint is inconsistent with current sealed authority.");
  if (receipt.state !== "READY_FOR_PUBLISH" && (!receipt.new_published_commit_sha || receipt.remote_branch_sha !== receipt.new_published_commit_sha || receipt.new_published_commit_sha === options.authority.publishedCommitSha)) {
    throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_RECOVERY_INVALID", "Durable Harness Web revision publication checkpoint is incomplete or stale.");
  }
}

async function tryHarnessWebRevision(options: {
  runId: string;
  revisionRound: number;
  stateDirectory: string;
  configPath: string;
  authority: RevisionOrchestrationAuthority;
  config: Awaited<ReturnType<typeof loadPhase4Config>>;
  runner: GitRunner;
  now?: () => Date;
}): Promise<RevisionReceipt | null> {
  const selected = await readSelectedArtifact(options.stateDirectory, options.runId);
  if (!selected) return null;
  const split = options.runId.lastIndexOf(":");
  const taskId = options.runId.slice(0, split);
  const archiveSha = options.runId.slice(split + 1);
  if (split < 1 || !SHA256.test(archiveSha)) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Revision run identity is invalid.");
  const executor = await readExecutorReceipt(options.stateDirectory, taskId, archiveSha, selected.artifact_sha256);
  if (!executor) throw new OrchestrationError("ORCHESTRATION_EXECUTOR_NOT_READY", "Harness-first revision requires a durable executor receipt.");
  if (executor.review_strategy === undefined) return null;

  const repair = executor.repair;
  if (!repair || repair.reviewer !== "web" || repair.state !== "VERIFIED" || !repair.final_change_set_digest) {
    throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_REPAIR_REQUIRED", "Harness-first final REVISION_REQUESTED requires bounded Web repair operations that were applied and deterministically verified before publication.");
  }
  if (executor.state !== "READY_FOR_PUBLISH" || !executor.change_set_digest || executor.change_set_digest !== repair.final_change_set_digest || !executor.verification.passed || executor.verification.change_set_digest !== executor.change_set_digest) {
    throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_REPAIR_INVALID", "Harness Web repair is not bound to the exact deterministic verification checkpoint.");
  }

  const source = await loadSealedRevisionSource(options.stateDirectory, options.runId, options.revisionRound);
  if (repair.source_change_set_digest !== source.previousResultBundle.receipt.change_set_sha256) {
    throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_REPAIR_STALE", "The verified Web repair does not originate from the exact Result generation reviewed by Web-A.");
  }

  const paths = resolveRevisionRoundPaths(options.stateDirectory, options.runId, options.revisionRound);
  await prepareRevisionRoundPaths(options.stateDirectory, paths);
  let receipt = await readRevisionReceipt(options.stateDirectory, paths.receiptPath);
  if (receipt) {
    assertHarnessRevisionCheckpoint(receipt, { runId: options.runId, revisionRound: options.revisionRound, authority: options.authority, finalDigest: executor.change_set_digest });
    if (receipt.state === "RESULT_READY") {
      assertRevisionResultForOrchestration(options.runId, receipt, options.authority);
      return receipt;
    }
  } else {
    const verificationCommands = await readExactVerificationCommands({
      executorDirectory: executorPaths(options.stateDirectory, taskId, archiveSha, selected.artifact_sha256).directory,
      round: executor.verification.rounds,
      evidenceSha256: executor.verification.evidence_sha256,
      changeSetSha256: executor.change_set_digest,
      requiredCommandsPassed: executor.verification.passed,
    });
    // Write-ahead checkpoint: seal the exact dirty repaired delta before the
    // first Git publication side effect. Recovery never has to reconstruct
    // this authority from a worktree whose HEAD may already have advanced.
    const delta = await calculateChangeSet({
      worktreePath: executor.worktree_path,
      baseCommit: options.authority.publishedCommitSha,
      branchName: source.previousResultBundle.receipt.pull_request.head_branch,
      runner: options.runner,
      allowedGeneratedPaths: options.config.verification.allowed_generated_paths,
    });
    if (delta.entries.length === 0) throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_EMPTY", "Harness Web revision produced no previous-head to repaired-worktree change-set.");
    if (!delta.refs_sha256 || !SHA256.test(delta.refs_sha256)) throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_REFS_INVALID", "Harness Web revision could not attest the pre-publication Git refs snapshot.");
    const revisionPaths = delta.entries.map((entry) => entry.path).sort();
    const approvedSnapshot = await calculateApprovedRevisionSnapshot({ runner: options.runner, worktreePath: executor.worktree_path, approvedPaths: revisionPaths });
    const nowIso = (options.now ? options.now() : new Date()).toISOString();
    const noReview = { model: "not-called-harness-web-repair", reasoning_effort: "minimal" as const, rounds: 0, thread_ids: [] as string[], verdict: null, reviewed_change_set_sha256: null };
    receipt = {
      phase_version: "1.0",
      run_id: options.runId,
      revision_round: options.revisionRound,
      state: "READY_FOR_PUBLISH",
      resume_state: null,
      spec_set_sha256: source.request.spec_set_sha256,
      revision_request_sha256: source.requestSha256,
      previous_result_bundle_sha256: source.request.previous_result_bundle_sha256,
      previous_result_receipt_sha256: source.previousResultBundle.phase6ReceiptSha256,
      previous_verdict_sha256: source.request.previous_verdict_sha256,
      previous_published_commit_sha: source.request.previous_published_commit_sha,
      previous_pr_head_sha: source.request.previous_pr_head_sha,
      pull_request_number: source.request.pull_request_number,
      branch_name: source.previousResultBundle.receipt.pull_request.head_branch,
      base_branch: source.previousResultBundle.receipt.pull_request.base_branch,
      worktree_path: executor.worktree_path,
      initial_refs_sha256: delta.refs_sha256,
      implementer: { model: "web-bounded-repair", reasoning_effort: "minimal", thread_id: null, iterations: 0 },
      verification: { rounds: executor.verification.rounds, required_commands_passed: true, verified_change_set_sha256: executor.change_set_digest, commands: verificationCommands },
      terra_review: { ...noReview },
      sol_review: { ...noReview },
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_turns: 0, implementation_iterations: 0, internal_review_rounds: 0, sol_review_rounds: 0, started_at: nowIso },
      revision_change_set_sha256: delta.change_set_sha256,
      revision_paths: revisionPaths,
      approved_snapshot_sha256: approvedSnapshot,
      new_published_commit_sha: null,
      remote_branch_sha: null,
      result_bundle_sha256: null,
      result_manifest_sha256: null,
      next_review_round: options.revisionRound + 1,
      errors: [],
      created_at: nowIso,
      updated_at: nowIso,
      completed_at: null,
    };
    await writeRevisionReceipt(paths.receiptPath, receipt);
  }

  if (receipt.state === "READY_FOR_PUBLISH") {
    const published = await publishReadyExecutorSnapshot({
      runId: options.runId,
      artifactSha256: selected.artifact_sha256,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      ...(options.now ? { now: options.now } : {}),
    });
    if (published.state !== "PUSHED" || !published.commit_sha || published.remote_branch_sha !== published.commit_sha || published.commit_sha === options.authority.publishedCommitSha) {
      throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_PUBLISH_INVALID", "Harness Web revision must fast-forward to a new exact PUSHED commit.");
    }
    const draft = await openDraftPullRequestForExecutorSnapshot({
      runId: options.runId,
      artifactSha256: selected.artifact_sha256,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      ...(options.now ? { now: options.now } : {}),
    });
    if (draft.state !== "OPEN" || draft.pull_number !== options.authority.pullRequestNumber || draft.observed_head_sha !== published.commit_sha || draft.observed_draft !== true) {
      throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_PR_INVALID", "Harness Web revision did not re-attest the same Draft PR at the repaired head.");
    }
    receipt.new_published_commit_sha = published.commit_sha;
    receipt.remote_branch_sha = published.remote_branch_sha;
    receipt.state = "PUSHED";
    receipt.updated_at = (options.now ? options.now() : new Date()).toISOString();
    await writeRevisionReceipt(paths.receiptPath, receipt);
  } else {
    const published = await publishReadyExecutorSnapshot({
      runId: options.runId,
      artifactSha256: selected.artifact_sha256,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      ...(options.now ? { now: options.now } : {}),
    });
    if (published.state !== "PUSHED" || published.commit_sha !== receipt.new_published_commit_sha || published.remote_branch_sha !== receipt.remote_branch_sha) {
      throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_RECOVERY_INVALID", "Recovered Harness Web revision publication no longer matches Phase10 durable authority.");
    }
    const draft = await openDraftPullRequestForExecutorSnapshot({
      runId: options.runId,
      artifactSha256: selected.artifact_sha256,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      ...(options.now ? { now: options.now } : {}),
    });
    if (draft.state !== "OPEN" || draft.pull_number !== receipt.pull_request_number || draft.observed_head_sha !== receipt.new_published_commit_sha || draft.observed_draft !== true) {
      throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_RECOVERY_INVALID", "Recovered Harness Web revision Draft PR no longer matches durable publication authority.");
    }
  }

  await writeCanonicalRevisionArtifact(paths.implementationPath, { run_id: options.runId, revision_round: options.revisionRound, authority: "web-bounded-repair", model_calls: 0, repair_source_change_set_sha256: repair.source_change_set_digest, repaired_change_set_sha256: executor.change_set_digest, revision_paths: receipt.revision_paths });
  await writeCanonicalRevisionArtifact(paths.verificationPath, receipt.verification);
  await writeCanonicalRevisionArtifact(paths.terraReviewPath, receipt.terra_review);
  await writeCanonicalRevisionArtifact(paths.solReviewPath, receipt.sol_review);

  const finalPr = await attestRevisionPullRequest({
    expected: {
      pullRequestUrl: source.previousResultBundle.receipt.pull_request.url,
      pullRequestNumber: source.request.pull_request_number,
      headBranch: receipt.branch_name,
      headSha: receipt.new_published_commit_sha!,
      baseBranch: receipt.base_branch,
      baseSha: source.previousResultBundle.receipt.base_commit,
    },
    config: options.config,
  });
  const publishArtifact = { run_id: options.runId, revision_round: options.revisionRound, previous_head_sha: source.request.previous_pr_head_sha, new_commit_sha: receipt.new_published_commit_sha, remote_branch_sha: receipt.remote_branch_sha, branch_name: receipt.branch_name, pull_request_number: receipt.pull_request_number, same_pull_request: true, force_push: false, merged: false, authority: "phase10-harness" };
  const publishWritten = await writeCanonicalRevisionArtifact(paths.publishPath, publishArtifact);
  const revisionEvidence = { run_id: options.runId, revision_round: options.revisionRound, state: "PUSHED", authority: "web-bounded-repair", model_calls: 0, sealed_revision_request_sha256: source.requestSha256, spec_set_sha256: receipt.spec_set_sha256, previous_result_bundle_sha256: receipt.previous_result_bundle_sha256, previous_result_receipt_sha256: receipt.previous_result_receipt_sha256, previous_verdict_sha256: receipt.previous_verdict_sha256, previous_head_sha: receipt.previous_pr_head_sha, repair_source_change_set_sha256: repair.source_change_set_digest, repaired_change_set_sha256: executor.change_set_digest, revision_change_set_sha256: receipt.revision_change_set_sha256, revision_paths: receipt.revision_paths, approved_snapshot_sha256: receipt.approved_snapshot_sha256, verification: receipt.verification, terra_review: receipt.terra_review, sol_review: receipt.sol_review, usage: receipt.usage, published_commit_sha: receipt.new_published_commit_sha, remote_branch_sha: receipt.remote_branch_sha };
  const revisionEvidenceWritten = await writeCanonicalRevisionArtifact(paths.evidencePath, revisionEvidence);

  const runContext = await resolveTrustedRunContext(options.runId, options.stateDirectory, options.configPath);
  const result = await packageRevisionResultBundle({
    stateDirectory: options.stateDirectory,
    paths,
    source,
    revisionReceipt: receipt,
    revisionEvidence,
    revisionEvidenceSha256: revisionEvidenceWritten.sha256,
    publishEvidence: publishArtifact,
    publishEvidenceSha256: publishWritten.sha256,
    prAttestation: finalPr,
    acceptedBundlePath: runContext.runReceipt.accepted_bundle_path,
    originalBaseCommit: executor.base_commit,
    worktreePath: executor.worktree_path,
    runner: options.runner,
    limits: options.config.result_bundle,
    secrets: collectSecrets(options.config),
    ...(options.now ? { now: options.now } : {}),
  });
  if (result.state !== "READY_FOR_WEB_REVIEW" || result.result_bundle_version !== "1.2" || result.input_kind !== "revision" || result.revision_round !== options.revisionRound || !result.archive_sha256 || !result.manifest_sha256 || result.published_commit_sha !== receipt.new_published_commit_sha || result.pull_request.number !== options.authority.pullRequestNumber) {
    throw new OrchestrationError("ORCHESTRATION_WEB_REVISION_RESULT_INVALID", "Harness Web revision did not produce an exact v1.2 same-PR Result Bundle.");
  }
  receipt.result_bundle_sha256 = result.archive_sha256;
  receipt.result_manifest_sha256 = result.manifest_sha256;
  receipt.state = "RESULT_READY";
  receipt.completed_at = (options.now ? options.now() : new Date()).toISOString();
  receipt.updated_at = receipt.completed_at;
  await writeRevisionReceipt(paths.receiptPath, receipt);
  return receipt;
}

export async function reviseRunForOrchestration(options: {
  runId: string;
  revisionRound: number;
  stateDirectory: string;
  configPath: string;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<RevisionReceipt> {
  let authPath: string | undefined;
  const authority = await attestRevisionAuthorityForOrchestration({ runId: options.runId, stateDirectory: options.stateDirectory });
  if (authority.revisionRound !== options.revisionRound) {
    throw new OrchestrationError("ORCHESTRATION_REVISION_AUTHORITY_INVALID", "Requested revision round does not match the latest sealed Web revision authority.");
  }
  try {
    const runContext = await resolveTrustedRunContext(options.runId, options.stateDirectory, options.configPath);
    if (!runContext.runReceipt.remote_url) throw new OrchestrationError("ORCHESTRATION_REVISION_HISTORY_INVALID", "Canonical run receipt has no trusted remote_url.");
    const config = await loadPhase4Config(options.configPath);
    if (!config.publish) throw new OrchestrationError("ORCHESTRATION_REVISION_CONFIG_INVALID", "Trusted publish configuration is required.");
    const runtimeDirectory = await prepareRuntimeDirectory(options.stateDirectory);
    const auth = await preparePublishGitSecurity(config.publish, runContext.runReceipt.remote_url, runtimeDirectory, process.env);
    if (auth.mode === "https_token") authPath = auth.askpassScriptPath;
    const runner = new GitRunner(process.env, runtimeDirectory, {
      identity: config.publish.identity,
      auth,
      allowedRemoteUrl: runContext.runReceipt.remote_url,
    });

    // Harness-first PAIR/AUTOPILOT: the terminal Web-A verdict already supplied
    // bounded repair bytes and materialization already applied + re-verified them.
    // Promote that exact checkpoint through same-PR publication and a v1.2
    // revision Result Bundle. No Codex runtime/client or second reviewer call is
    // created on this path. Legacy pre-Harness runs retain the old Phase 8 path.
    const harness = await tryHarnessWebRevision({
      runId: options.runId,
      revisionRound: options.revisionRound,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      authority,
      config,
      runner,
      ...(options.now ? { now: options.now } : {}),
    });
    if (harness) {
      assertRevisionResultForOrchestration(options.runId, harness, authority);
      return harness;
    }

    const runtime = await resolveCodexRuntime(config.runtime, options.stateDirectory);
    const receipt = await reviseRun({
      runId: options.runId,
      revisionRound: options.revisionRound,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      agentClient: new CodexSdkAgentClient(runtime),
      sandbox: new BubblewrapVerificationSandbox(),
      gitRunner: runner,
      secrets: collectSecrets(config),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    assertRevisionResultForOrchestration(options.runId, receipt, authority);
    return receipt;
  } finally {
    if (authPath) await fs.unlink(authPath).catch(() => undefined);
  }
}
