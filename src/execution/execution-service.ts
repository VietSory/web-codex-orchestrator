import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { GitRunner } from "../git/git-runner.js";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "../agent/contracts.js";
import { assessWithTerra, implementWithTerra } from "../agent/terra-implementer.js";
import { reviewWithTerra } from "../agent/terra-reviewer.js";
import { reviewWithSol } from "../agent/sol-reviewer.js";
import type { ReviewResult } from "./contracts.js";
import type { ExecutionReceipt, ExecutionState, ChangeSet } from "./contracts.js";
import { ExecutionError, isExecutionError } from "./errors.js";
import { assertPhase4ExecutionContract } from "./execution-validator.js";
import { loadPhase4Config, readBundleJson, effectiveLimit, type Phase4Config } from "./execution-config.js";
import { acquireExecutionLock } from "./execution-lock.js";
import { appendAgentEvent, appendExecutionEvent, ensureExecutionDirectory, executionPaths, readExecutionReceipt, readPreparationForExecution, writeExecutionArtifact, writeExecutionReceipt } from "./execution-store.js";
import { assertTransition } from "./state-machine.js";
import { BudgetTracker, defaultAgentLimits } from "./budget.js";
import { snapshotBundle, assertBundleUnchanged, type BundleSnapshot } from "./bundle-integrity.js";
import { calculateChangeSet } from "./change-set.js";
import { enforcePathPolicy } from "./path-policy.js";
import { validateReviewFindings } from "../agent/output-validator.js";
import { assertReadyForPublish, assertSolCanStart, assertTerraCanStart, invalidateReviews } from "./review-gates.js";
import { verifyDeterministically } from "../verifier/verifier.js";
import type { VerificationSandbox } from "../verifier/contracts.js";
import { verifyBundleChecksums } from "../intake/checksum-verifier.js";

export interface ExecutionOptions {
  runId: string;
  stateDirectory: string;
  configPath: string;
  agentClient?: AgentClient;
  sandbox?: VerificationSandbox;
  runner?: GitRunner;
  signal?: AbortSignal;
  now?: () => Date;
}

function subpath(root: string, target: string): boolean { const canonicalRoot = path.resolve(root); const canonicalTarget = path.resolve(target); return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`); }
function errorCode(error: unknown): string { return isExecutionError(error) ? error.code : error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "OPERATIONAL_ERROR"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function withAgentTimeout(client: AgentClient, timeoutSeconds: number): AgentClient {
  return { async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client.turn(request),
        new Promise<AgentTurnResponse>((_, reject) => { timer = setTimeout(() => reject(new ExecutionError("CODEX_TURN_TIMEOUT", "Agent turn timed out.")), timeoutSeconds * 1000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  } };
}

function initialReceipt(runId: string, prep: Awaited<ReturnType<typeof readPreparationForExecution>>, config: Phase4Config, now: () => Date): ExecutionReceipt {
  const timestamp = now().toISOString();
  return { execution_version: "1.0", run_id: runId, state: "READY_FOR_CODEX", base_commit: prep.receipt.base_commit, branch_name: prep.receipt.branch_name, worktree_path: prep.receipt.worktree_path, accepted_bundle_path: prep.receipt.accepted_bundle_path, implementer: { model: config.agents.implementer.model, reasoning_effort: config.agents.implementer.reasoning_effort, thread_id: "", iterations: 0 }, internal_reviewer: { model: config.agents.internal_reviewer.model, reasoning_effort: config.agents.internal_reviewer.reasoning_effort, rounds: 0, latest_thread_id: null, verdict: null, reviewed_change_set_sha256: null }, final_reviewer: { model: config.agents.final_reviewer.model, reasoning_effort: config.agents.final_reviewer.reasoning_effort, rounds: 0, latest_thread_id: null, verdict: null, reviewed_change_set_sha256: null }, verification: { rounds: 0, required_commands_passed: false, verified_change_set_sha256: null, commands: [] }, change_set_sha256: null, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, errors: [], created_at: timestamp, updated_at: timestamp };
}

export class ExecutionService {
  private readonly now: () => Date;
  constructor(private readonly options: ExecutionOptions) { this.now = options.now ?? (() => new Date()); }

  private async transition(receipt: ExecutionReceipt, to: ExecutionState, details: Record<string, unknown> = {}): Promise<void> {
    assertTransition(receipt.state, to);
    const from = receipt.state; receipt.state = to; receipt.updated_at = this.now().toISOString();
    const separator = receipt.run_id.lastIndexOf(":");
    await appendExecutionEvent(this.options.stateDirectory, receipt.run_id.slice(0, separator), receipt.run_id.slice(separator + 1), receipt.run_id, from, to, details, this.now);
    await writeExecutionReceipt(this.options.stateDirectory, receipt);
  }

  private async preflight(receipt: ExecutionReceipt, config: Phase4Config, bundle: BundleSnapshot, runner: GitRunner): Promise<void> {
    const stateRoot = path.resolve(this.options.stateDirectory);
    const worktree = path.resolve(receipt.worktree_path);
    const bundlePath = path.resolve(receipt.accepted_bundle_path);
    if (!subpath(path.join(stateRoot, "worktrees"), worktree)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Worktree is outside state-dir/worktrees.");
    if (!subpath(path.join(stateRoot, "accepted"), bundlePath)) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Accepted bundle is outside state-dir/accepted.");
    let worktreeInfo; let bundleInfo; let canonicalWorktree; let canonicalBundle;
    try { [worktreeInfo, bundleInfo, canonicalWorktree, canonicalBundle] = await Promise.all([lstat(worktree), lstat(bundlePath), realpath(worktree), realpath(bundlePath)]); } catch (error) { throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", `Prepared path is missing or unsafe: ${error instanceof Error ? error.message : String(error)}`); }
    if (!worktreeInfo.isDirectory() || worktreeInfo.isSymbolicLink() || canonicalWorktree !== worktree) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Worktree is not a canonical real directory.");
    if (!bundleInfo.isDirectory() || bundleInfo.isSymbolicLink() || canonicalBundle !== bundlePath) throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle is not a canonical real directory.");
    const headResult = await runner.run(["rev-parse", "HEAD"], worktree); const branchResult = await runner.run(["branch", "--show-current"], worktree);
    if (headResult.exitCode !== 0 || branchResult.exitCode !== 0) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Prepared worktree is not a readable Git worktree.");
    const head = headResult.stdout.trim(); const branch = branchResult.stdout.trim();
    if (head !== receipt.base_commit) throw new ExecutionError("AGENT_COMMITTED_CHANGES", "Worktree HEAD does not equal the exact base commit.");
    if (branch !== receipt.branch_name) throw new ExecutionError("AGENT_CHANGED_BRANCH", "Worktree branch does not equal the preparation branch.");
    if (!config.agents || !config.verification) throw new ExecutionError("EXECUTION_CONFIG_INVALID", "Trusted Phase 4 configuration is incomplete.");
    void bundle;
  }

  async execute(): Promise<ExecutionReceipt> {
    const stateRoot = path.resolve(this.options.stateDirectory);
    try { const stateInfo = await lstat(stateRoot); const canonicalState = await realpath(stateRoot); if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory() || canonicalState !== stateRoot) throw new Error("state directory is unsafe"); } catch (error) { throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", `State directory is unsafe: ${error instanceof Error ? error.message : String(error)}`); }
    const { receipt: preparation, taskId, archiveSha256 } = await readPreparationForExecution(this.options.stateDirectory, this.options.runId);
    const lock = await acquireExecutionLock(this.options.stateDirectory, archiveSha256);
    const now = this.now;
    let execution: ExecutionReceipt | undefined;
    try {
      const config = await loadPhase4Config(this.options.configPath);
      const paths = executionPaths(this.options.stateDirectory, taskId, archiveSha256); await ensureExecutionDirectory(paths);
      execution = await readExecutionReceipt(this.options.stateDirectory, taskId, archiveSha256);
      if (execution) {
        if (execution.run_id !== this.options.runId || execution.worktree_path !== preparation.worktree_path || execution.base_commit !== preparation.base_commit || execution.branch_name !== preparation.branch_name) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Persisted execution receipt does not match preparation.");
      } else execution = initialReceipt(this.options.runId, { receipt: preparation, taskId, archiveSha256 }, config, now);
      const runner = this.options.runner ?? new GitRunner(process.env, path.join(path.resolve(this.options.stateDirectory), "git-runtime"));
      const bundleData = await readBundleJson(preparation.accepted_bundle_path);
      const contractReport = assertPhase4ExecutionContract(bundleData.manifest);
      const contract = contractReport;
      try { await verifyBundleChecksums(preparation.accepted_bundle_path); } catch (error) { throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle checksum verification failed: ${error instanceof Error ? error.message : String(error)}`); }
      const requiredAcceptanceIds = Array.isArray((bundleData.acceptance as { criteria?: unknown }).criteria)
        ? ((bundleData.acceptance as { criteria: Array<{ id?: unknown; required?: unknown }> }).criteria.filter((criterion) => criterion.required === true && typeof criterion.id === "string").map((criterion) => criterion.id as string))
        : [];
      const bundleSnapshot = await snapshotBundle(preparation.accepted_bundle_path);
      await this.preflight(execution, config, bundleSnapshot, runner);
      const currentAtStart = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
      if (!execution.change_set_sha256 && currentAtStart.entries.length > 0) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Prepared worktree is not clean at execution start.");
      if (execution.change_set_sha256 && execution.change_set_sha256 !== currentAtStart.change_set_sha256) {
        if (execution.state === "READY_FOR_PUBLISH") throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Completed execution receipt no longer matches the worktree.");
        invalidateReviews(execution);
        execution.change_set_sha256 = currentAtStart.change_set_sha256;
        if (["TERRA_REVIEWING", "SOL_REVIEWING", "VERIFYING", "VERIFICATION_FAILED"].includes(execution.state)) {
          await this.transition(execution, "TERRA_FIXING", { reason: "change-set-digest-changed" });
        }
      }
      if (execution.state === "READY_FOR_PUBLISH") {
        if (!execution.change_set_sha256 || execution.verification.verified_change_set_sha256 !== execution.change_set_sha256 || execution.internal_reviewer.reviewed_change_set_sha256 !== execution.change_set_sha256 || execution.final_reviewer.reviewed_change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Completed execution receipt is missing matching verification and review digests.");
        return execution;
      }
      await writeExecutionReceipt(this.options.stateDirectory, execution);
      if (execution.state === "READY_FOR_CODEX") await this.transition(execution, "CODEX_PREFLIGHT");
      if (!this.options.agentClient) throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "A supported Codex runtime client is not configured.");
      if (!this.options.sandbox) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "A supported Codex verification sandbox is not configured.");
      const client = withAgentTimeout(this.options.agentClient, config.agents.limits.maximum_turn_seconds);
      const limits = config.agents.limits ?? defaultAgentLimits();
      const budget = new BudgetTracker({ ...limits, maximum_implementation_iterations: effectiveLimit(limits.maximum_implementation_iterations, contract.limits.max_internal_iterations), maximum_internal_review_rounds: effectiveLimit(limits.maximum_internal_review_rounds, contract.limits.max_review_rounds), maximum_sol_review_rounds: effectiveLimit(limits.maximum_sol_review_rounds, contract.limits.max_review_rounds) }, Date.now(), { implementationIterations: execution.implementer.iterations, internalReviewRounds: execution.internal_reviewer.rounds, solReviewRounds: execution.final_reviewer.rounds, totalTurns: execution.implementer.iterations + execution.internal_reviewer.rounds + execution.final_reviewer.rounds, inputTokens: execution.usage.input_tokens, outputTokens: execution.usage.output_tokens });
      let changeSet: ChangeSet = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
      execution.change_set_sha256 = changeSet.change_set_sha256;

      if (execution.state === "CODEX_PREFLIGHT") {
        await this.transition(execution, "TERRA_ASSESSING");
        const before = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        let assessed: Awaited<ReturnType<typeof assessWithTerra>>;
        try {
          assessed = await assessWithTerra(client, { model: execution.implementer.model, reasoning_effort: execution.implementer.reasoning_effort, prompt: `${bundleData.request}\n\nPlan:\n${bundleData.plan}\n\nRules:\n${bundleData.rules}`, signal: this.options.signal });
        } catch (error) {
          if (!isExecutionError(error) || error.code !== "AGENT_OUTPUT_INVALID") throw error;
          await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
          const repair = await assessWithTerra(client, { model: execution.implementer.model, reasoning_effort: execution.implementer.reasoning_effort, prompt: "Your previous response was invalid. Return exactly the required assessment JSON and no other fields.", signal: this.options.signal });
          assessed = repair;
        }
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        const after = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        if (before.change_set_sha256 !== after.change_set_sha256) throw new ExecutionError("AGENT_ASSESSMENT_MUTATED_WORKTREE", "Terra assessment changed the worktree.");
        execution.implementer.thread_id = assessed.response.thread_id;
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "implementation", assessed.assessment, "assessment.json");
        await appendAgentEvent(this.options.stateDirectory, taskId, archiveSha256, { event_version: "1.0", role: "implementer", phase: "assessment", thread_id: assessed.response.thread_id, prompt_sha256: "redacted", usage: assessed.response.usage ?? {} });
        execution.usage.input_tokens += assessed.response.usage?.input_tokens ?? 0; execution.usage.cached_input_tokens += assessed.response.usage?.cached_input_tokens ?? 0; execution.usage.output_tokens += assessed.response.usage?.output_tokens ?? 0;
        budget.recordTokens(assessed.response.usage?.input_tokens, assessed.response.usage?.output_tokens);
        if (assessed.assessment.status === "REPLAN_REQUIRED") { await this.transition(execution, "REPLAN_REQUIRED"); execution.errors.push({ code: "REPLAN_REQUIRED", message: assessed.assessment.summary }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        if (assessed.assessment.status === "HUMAN_REQUIRED") { await this.transition(execution, "HUMAN_REQUIRED"); execution.errors.push({ code: "HUMAN_REQUIRED", message: assessed.assessment.summary }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        if (assessed.assessment.status === "BLOCKED") { await this.transition(execution, "POLICY_BLOCKED"); execution.errors.push({ code: "POLICY_BLOCKED", message: assessed.assessment.summary }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        await this.transition(execution, "TERRA_IMPLEMENTING");
      }

      while (execution.state === "TERRA_IMPLEMENTING" || execution.state === "TERRA_FIXING") {
        budget.beginImplementation(); execution.implementer.iterations += 1;
        if (execution.state === "TERRA_FIXING") await this.transition(execution, "TERRA_IMPLEMENTING");
        const implemented = await implementWithTerra(client, { model: execution.implementer.model, reasoning_effort: execution.implementer.reasoning_effort, threadId: execution.implementer.thread_id, prompt: `${bundleData.request}\n\nBlocking findings and current digest: ${execution.change_set_sha256 ?? ""}`, signal: this.options.signal });
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        execution.implementer.thread_id = implemented.response.thread_id;
        await appendAgentEvent(this.options.stateDirectory, taskId, archiveSha256, { event_version: "1.0", role: "implementer", phase: "implementation", thread_id: implemented.response.thread_id, prompt_sha256: "redacted", usage: implemented.response.usage ?? {} });
        execution.usage.input_tokens += implemented.response.usage?.input_tokens ?? 0; execution.usage.cached_input_tokens += implemented.response.usage?.cached_input_tokens ?? 0; execution.usage.output_tokens += implemented.response.usage?.output_tokens ?? 0;
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "implementation", implemented.implementation, `iteration-${String(execution.implementer.iterations).padStart(3, "0")}.json`);
        budget.recordTokens(implemented.response.usage?.input_tokens, implemented.response.usage?.output_tokens);
        if (implemented.implementation.status === "REPLAN_REQUIRED") { await this.transition(execution, "REPLAN_REQUIRED"); execution.errors.push({ code: "REPLAN_REQUIRED", message: implemented.implementation.summary }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        if (implemented.implementation.status === "HUMAN_REQUIRED") { await this.transition(execution, "HUMAN_REQUIRED"); execution.errors.push({ code: "HUMAN_REQUIRED", message: implemented.implementation.summary }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        if (implemented.implementation.status === "BLOCKED") { await this.transition(execution, "POLICY_BLOCKED"); execution.errors.push({ code: "POLICY_BLOCKED", message: implemented.implementation.summary }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        changeSet = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        await enforcePathPolicy({ worktreePath: execution.worktree_path, allowedPaths: contract.allowed_paths, forbiddenPaths: contract.forbidden_paths, maximumChangedFiles: contract.limits.max_changed_files, maximumDiffLines: contract.limits.max_diff_lines, allowedGeneratedPaths: config.verification.allowed_generated_paths }, changeSet);
        execution.change_set_sha256 = changeSet.change_set_sha256;
        await this.transition(execution, "POLICY_CHECKING");
        await this.transition(execution, "VERIFYING");
        const verification = await verifyDeterministically({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, validation: bundleData.validation, policy: config.verification, sandbox: this.options.sandbox, runner, signal: this.options.signal, now });
        execution.verification.rounds += 1; execution.verification.required_commands_passed = verification.required_commands_passed; execution.verification.commands = verification.commands; execution.verification.verified_change_set_sha256 = verification.changeSet.change_set_sha256; execution.change_set_sha256 = verification.changeSet.change_set_sha256;
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "verification", verification, `round-${String(execution.verification.rounds).padStart(3, "0")}/summary.json`);
        if (!verification.required_commands_passed) { await this.transition(execution, "VERIFICATION_FAILED"); invalidateReviews(execution); if (execution.implementer.iterations >= budget.usage.implementationIterations && budget.usage.implementationIterations >= limits.maximum_implementation_iterations) { await this.transition(execution, "BUDGET_EXHAUSTED"); return execution; } await this.transition(execution, "TERRA_FIXING"); continue; }
        await this.transition(execution, "TERRA_REVIEWING");
        budget.beginInternalReview();
        const terraBefore = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        const terra = await reviewWithTerra(client, { model: execution.internal_reviewer.model, reasoning_effort: execution.internal_reviewer.reasoning_effort, prompt: `${bundleData.request}\nBase commit: ${execution.base_commit}\nBranch: ${execution.branch_name}\nChange-set digest: ${execution.change_set_sha256}\nActual changed paths: ${JSON.stringify(changeSet.entries)}\nThe verifier passed. Review only.`, signal: this.options.signal });
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        const terraAfter = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        if (terraBefore.change_set_sha256 !== terraAfter.change_set_sha256) throw new ExecutionError("TERRA_REVIEW_MUTATED_WORKTREE", "Terra reviewer changed the worktree.");
        if (terraAfter.change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("TERRA_REVIEW_STALE", "The worktree changed while Terra reviewed it.");
        const terraReview = terra.review; execution.internal_reviewer.rounds += 1; execution.internal_reviewer.latest_thread_id = terra.threadId; execution.internal_reviewer.verdict = terraReview.verdict; execution.internal_reviewer.reviewed_change_set_sha256 = terraReview.reviewed_change_set_sha256;
        execution.usage.input_tokens += terra.response.usage?.input_tokens ?? 0; execution.usage.cached_input_tokens += terra.response.usage?.cached_input_tokens ?? 0; execution.usage.output_tokens += terra.response.usage?.output_tokens ?? 0;
        budget.recordTokens(terra.response.usage?.input_tokens, terra.response.usage?.output_tokens);
        await validateReviewFindings(terraReview, execution.worktree_path, "TERRA_REVIEW_OUTPUT_INVALID");
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "terra-review", terraReview, `round-${String(execution.internal_reviewer.rounds).padStart(3, "0")}/verdict.json`);
        await appendAgentEvent(this.options.stateDirectory, taskId, archiveSha256, { event_version: "1.0", role: "internal_reviewer", phase: "review", thread_id: terra.threadId, prompt_sha256: "redacted", usage: terra.response?.usage ?? {} });
        if (terra.threadId === execution.implementer.thread_id) throw new ExecutionError("TERRA_REVIEW_OUTPUT_INVALID", "Terra reviewer must use a fresh thread.");
        if (terraReview.reviewed_change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("TERRA_REVIEW_STALE", "Terra review digest is stale.");
        if (terraReview.verdict === "REVISE") { invalidateReviews(execution); await this.transition(execution, "TERRA_FIXING"); continue; }
        if (terraReview.verdict === "REPLAN") { await this.transition(execution, "WEB_REVIEW_REQUIRED"); return execution; }
        if (terraReview.verdict === "ESCALATE") { await this.transition(execution, "HUMAN_REQUIRED"); return execution; }
        assertTerraCanStart(execution);
        await this.transition(execution, "SOL_REVIEWING");
        budget.beginSolReview();
        assertSolCanStart(execution, terraReview, requiredAcceptanceIds);
        const solBefore = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        const sol = await reviewWithSol(client, { model: execution.final_reviewer.model, reasoning_effort: execution.final_reviewer.reasoning_effort, prompt: `${bundleData.request}\nBase commit: ${execution.base_commit}\nBranch: ${execution.branch_name}\nChange-set digest: ${execution.change_set_sha256}\nActual changed paths: ${JSON.stringify(changeSet.entries)}\nTerra review evidence: ${terraReview.summary}\nVerify independently in read-only mode.`, signal: this.options.signal });
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        const solAfter = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        if (solBefore.change_set_sha256 !== solAfter.change_set_sha256) throw new ExecutionError("REVIEW_MUTATED_WORKTREE", "Sol reviewer changed the worktree.");
        if (solAfter.change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("REVIEW_STALE", "The worktree changed while Sol reviewed it.");
        const solReview = sol.review; execution.final_reviewer.rounds += 1; execution.final_reviewer.latest_thread_id = sol.threadId; execution.final_reviewer.verdict = solReview.verdict; execution.final_reviewer.reviewed_change_set_sha256 = solReview.reviewed_change_set_sha256;
        execution.usage.input_tokens += sol.response.usage?.input_tokens ?? 0; execution.usage.cached_input_tokens += sol.response.usage?.cached_input_tokens ?? 0; execution.usage.output_tokens += sol.response.usage?.output_tokens ?? 0;
        budget.recordTokens(sol.response.usage?.input_tokens, sol.response.usage?.output_tokens);
        await validateReviewFindings(solReview, execution.worktree_path, "REVIEW_OUTPUT_INVALID");
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "sol-review", solReview, `round-${String(execution.final_reviewer.rounds).padStart(3, "0")}/verdict.json`);
        await appendAgentEvent(this.options.stateDirectory, taskId, archiveSha256, { event_version: "1.0", role: "final_reviewer", phase: "review", thread_id: sol.threadId, prompt_sha256: "redacted", usage: sol.response?.usage ?? {} });
        if (sol.threadId === execution.implementer.thread_id || sol.threadId === execution.internal_reviewer.latest_thread_id) throw new ExecutionError("REVIEW_OUTPUT_INVALID", "Sol reviewer must use an independent thread.");
        if (solReview.reviewed_change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("REVIEW_STALE", "Sol review digest is stale.");
        if (solReview.verdict === "REVISE") { invalidateReviews(execution); await this.transition(execution, "TERRA_FIXING"); continue; }
        if (solReview.verdict === "REPLAN") { await this.transition(execution, "WEB_REVIEW_REQUIRED"); return execution; }
        if (solReview.verdict === "ESCALATE") { await this.transition(execution, "HUMAN_REQUIRED"); return execution; }
        assertReadyForPublish(execution, terraReview, solReview, requiredAcceptanceIds);
        await this.transition(execution, "READY_FOR_PUBLISH", { change_set_sha256: execution.change_set_sha256 });
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        return execution;
      }
      return execution;
    } catch (error) {
      const code = errorCode(error); const message = errorMessage(error);
      if (execution) { execution.errors.push({ code, message }); if (!["READY_FOR_PUBLISH", "REPLAN_REQUIRED", "HUMAN_REQUIRED", "WEB_REVIEW_REQUIRED", "POLICY_BLOCKED", "BUDGET_EXHAUSTED", "INTERRUPTED", "VERIFICATION_FAILED", "AGENT_FAILED"].includes(execution.state)) { const terminal = code === "BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : code === "INTERRUPTED" ? "INTERRUPTED" : ["AGENT_OUTPUT_INVALID", "TERRA_REVIEW_OUTPUT_INVALID", "REVIEW_OUTPUT_INVALID", "TERRA_REVIEW_MUTATED_WORKTREE", "REVIEW_MUTATED_WORKTREE", "CODEX_TURN_FAILED", "CODEX_TURN_TIMEOUT"].includes(code) ? "AGENT_FAILED" : ["VERIFIER_TIMEOUT", "VERIFIER_OUTPUT_LIMIT", "VERIFIER_MUTATED_SOURCE", "VERIFICATION_FAILED"].includes(code) ? "VERIFICATION_FAILED" : ["VALIDATION_CONTRACT_INVALID", "VALIDATION_EXECUTABLE_DENIED", "VALIDATION_ENVIRONMENT_DENIED", "VALIDATION_CWD_UNSAFE"].includes(code) ? "POLICY_BLOCKED" : "FAILED"; try { await this.transition(execution, terminal); } catch { execution.state = terminal; } } await writeExecutionReceipt(this.options.stateDirectory, execution).catch(() => undefined); }
      throw error;
    } finally { await lock.release(); }
  }
}

export async function executeRun(options: ExecutionOptions): Promise<ExecutionReceipt> { return new ExecutionService(options).execute(); }

export const executePhase4 = executeRun;
