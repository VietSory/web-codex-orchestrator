import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { GitRunner } from "../git/git-runner.js";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "../agent/contracts.js";
import { assessWithTerra, implementWithTerra } from "../agent/terra-implementer.js";
import { reviewWithTerra } from "../agent/terra-reviewer.js";
import { reviewWithSol } from "../agent/sol-reviewer.js";
import type { ReviewResult, ReviewFinding, ExecutionReceipt, ExecutionState, ChangeSet, VerificationCommandResult, VerificationFailureEvidence } from "./contracts.js";
import { ExecutionError, isExecutionError } from "./errors.js";
import { assertPhase4ExecutionContract } from "./execution-validator.js";
import { loadPhase4Config, readBundleJson, effectiveLimit } from "./execution-config.js";
import { acquireExecutionLock } from "./execution-lock.js";
import { appendAgentEvent, appendExecutionEvent, ensureExecutionDirectory, executionPaths, readExecutionReceipt, readPreparationForExecution, writeExecutionArtifact, writeExecutionReceipt, writeExecutionText } from "./execution-store.js";
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
import { redact } from "../evidence/log-redaction.js";
import type { Phase4Config } from "./execution-config.js";

export interface ExecutionOptions {
  runId: string;
  stateDirectory: string;
  configPath: string;
  config?: Phase4Config;
  agentClient?: AgentClient;
  sandbox?: VerificationSandbox;
  runner?: GitRunner;
  signal?: AbortSignal;
  now?: () => Date;
}

function subpath(root: string, target: string): boolean { const canonicalRoot = path.resolve(root); const canonicalTarget = path.resolve(target); return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`); }
function errorCode(error: unknown): string { return isExecutionError(error) ? error.code : error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "OPERATIONAL_ERROR"; }
function errorMessage(error: unknown): string { return redact(error instanceof Error ? error.message : String(error)).slice(0, 16_384); }
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExecutionError("INTERRUPTED", "Execution was cancelled.");
}

function boundedVerificationEvidence(commands: VerificationCommandResult[]): string {
  return JSON.stringify(commands.map((command) => ({
    command_id: command.command_id,
    specification_sha256: command.specification_sha256,
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    environment_keys: command.environment_keys,
    exit_code: command.exit_code,
    signal: command.signal,
    timed_out: command.timed_out,
    duration_ms: command.duration_ms,
    status: command.status,
    generated_paths: command.generated_paths,
    stdout: redact(command.stdout ?? "").slice(-8_192),
    stderr: redact(command.stderr ?? "").slice(-8_192),
  })));
}

async function boundedTrackedDiff(runner: GitRunner, baseCommit: string, worktreePath: string): Promise<string> {
  const result = await runner.run(["diff", "--no-ext-diff", baseCommit, "--"], worktreePath);
  return result.exitCode === 0 ? redact(result.stdout).slice(-32_768) : "[diff unavailable]";
}

function boundedPromptText(value: string, maximum = 32_768): string {
  return redact(value).slice(0, maximum);
}

function boundedPromptJson(value: unknown, maximum = 32_768): string {
  try { return boundedPromptText(JSON.stringify(value), maximum); } catch { return "[unavailable]"; }
}

function assertAcceptanceResults(review: ReviewResult, allowedIds: readonly string[], code: "TERRA_REVIEW_OUTPUT_INVALID" | "REVIEW_OUTPUT_INVALID"): void {
  const allowed = new Set(allowedIds);
  if (review.acceptance_results.some((result) => !allowed.has(result.acceptance_id))) throw new ExecutionError(code, "Reviewer returned an acceptance criterion outside the accepted bundle.");
}

function withAgentTimeout(client: AgentClient, timeoutSeconds: number): AgentClient {
  return {
    async checkAvailability(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.checkAvailability(),
          new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new ExecutionError("CODEX_TURN_TIMEOUT", "Codex runtime preflight timed out.")), timeoutSeconds * 1000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    },
    async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelHandler: (() => void) | undefined;
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      request.signal?.addEventListener("abort", forwardAbort, { once: true });
      if (request.signal?.aborted) controller.abort();
      const delegated = { ...request, signal: controller.signal };
      try {
        return await Promise.race([
          client.turn(delegated),
          new Promise<AgentTurnResponse>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ExecutionError("CODEX_TURN_TIMEOUT", "Agent turn timed out.")); }, timeoutSeconds * 1000); }),
          new Promise<AgentTurnResponse>((_, reject) => { cancelHandler = () => reject(new ExecutionError("INTERRUPTED", "Execution was cancelled.")); if (request.signal?.aborted) cancelHandler(); else request.signal?.addEventListener("abort", cancelHandler, { once: true }); }),
        ]);
      } finally { if (timer) clearTimeout(timer); request.signal?.removeEventListener("abort", forwardAbort); if (cancelHandler) request.signal?.removeEventListener("abort", cancelHandler); }
    },
  };
}

function initialReceipt(runId: string, prep: Awaited<ReturnType<typeof readPreparationForExecution>>, config: Phase4Config, now: () => Date): ExecutionReceipt {
  const timestamp = now().toISOString();
  return { execution_version: "1.0", run_id: runId, state: "READY_FOR_CODEX", base_commit: prep.receipt.base_commit, branch_name: prep.receipt.branch_name, worktree_path: prep.receipt.worktree_path, accepted_bundle_path: prep.receipt.accepted_bundle_path, repository_refs_sha256: null, implementer: { model: config.agents.implementer.model, reasoning_effort: config.agents.implementer.reasoning_effort, thread_id: "", iterations: 0 }, internal_reviewer: { model: config.agents.internal_reviewer.model, reasoning_effort: config.agents.internal_reviewer.reasoning_effort, rounds: 0, latest_thread_id: null, thread_ids: [], verdict: null, reviewed_change_set_sha256: null }, final_reviewer: { model: config.agents.final_reviewer.model, reasoning_effort: config.agents.final_reviewer.reasoning_effort, rounds: 0, latest_thread_id: null, thread_ids: [], verdict: null, reviewed_change_set_sha256: null }, verification: { rounds: 0, required_commands_passed: false, verified_change_set_sha256: null, commands: [] }, change_set_sha256: null, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_turns: 0, started_at: timestamp }, errors: [], created_at: timestamp, updated_at: timestamp };
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
      const config = this.options.config ?? await loadPhase4Config(this.options.configPath);
      const paths = executionPaths(this.options.stateDirectory, taskId, archiveSha256); await ensureExecutionDirectory(paths);
      execution = await readExecutionReceipt(this.options.stateDirectory, taskId, archiveSha256);
      if (execution) {
        if (execution.run_id !== this.options.runId || execution.worktree_path !== preparation.worktree_path || execution.base_commit !== preparation.base_commit || execution.branch_name !== preparation.branch_name) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Persisted execution receipt does not match preparation.");
      } else execution = initialReceipt(this.options.runId, { receipt: preparation, taskId, archiveSha256 }, config, now);
      throwIfAborted(this.options.signal);
      const runner = this.options.runner ?? new GitRunner(process.env, path.join(path.resolve(this.options.stateDirectory), "git-runtime"));
      const bundleData = await readBundleJson(preparation.accepted_bundle_path);
      const contractReport = assertPhase4ExecutionContract(bundleData.manifest);
      const contract = contractReport;
      if (preparation.repository_id !== contract.repository.id || preparation.remote !== contract.delivery.remote || preparation.base_branch !== contract.repository.base_branch || preparation.base_commit !== contract.repository.base_commit || preparation.branch_name !== contract.delivery.branch_name) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Phase 3 receipt does not match the accepted Phase 4 execution contract.");
      try { await verifyBundleChecksums(preparation.accepted_bundle_path); } catch (error) { throw new ExecutionError("BUNDLE_MUTATED", `Accepted bundle checksum verification failed: ${error instanceof Error ? error.message : String(error)}`); }
      const acceptanceCriteria = Array.isArray((bundleData.acceptance as { criteria?: unknown }).criteria)
        ? (bundleData.acceptance as { criteria: Array<{ id?: unknown; required?: unknown }> }).criteria
        : [];
      const allAcceptanceIds = acceptanceCriteria.filter((criterion) => typeof criterion.id === "string").map((criterion) => criterion.id as string);
      const requiredAcceptanceIds = acceptanceCriteria.filter((criterion) => criterion.required === true && typeof criterion.id === "string").map((criterion) => criterion.id as string);
      const bundleSnapshot = await snapshotBundle(preparation.accepted_bundle_path);
      await this.preflight(execution, config, bundleSnapshot, runner);
      const currentAtStart = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
      if (execution.repository_refs_sha256 !== undefined && execution.repository_refs_sha256 !== null && execution.repository_refs_sha256 !== currentAtStart.refs_sha256) throw new ExecutionError("AGENT_COMMITTED_CHANGES", "Git refs changed outside the Phase 4 execution.");
      execution.repository_refs_sha256 ??= currentAtStart.refs_sha256 ?? null;
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
        const terraThreads = execution.internal_reviewer.thread_ids ?? (execution.internal_reviewer.latest_thread_id ? [execution.internal_reviewer.latest_thread_id] : []);
        const solThreads = execution.final_reviewer.thread_ids ?? (execution.final_reviewer.latest_thread_id ? [execution.final_reviewer.latest_thread_id] : []);
        if (!execution.change_set_sha256 || !execution.verification.required_commands_passed || execution.verification.verified_change_set_sha256 !== execution.change_set_sha256 || execution.internal_reviewer.verdict !== "APPROVE" || execution.final_reviewer.verdict !== "APPROVE" || execution.internal_reviewer.rounds < 1 || execution.final_reviewer.rounds < 1 || execution.internal_reviewer.reviewed_change_set_sha256 !== execution.change_set_sha256 || execution.final_reviewer.reviewed_change_set_sha256 !== execution.change_set_sha256 || !execution.internal_reviewer.latest_thread_id || !execution.final_reviewer.latest_thread_id || execution.internal_reviewer.latest_thread_id === execution.implementer.thread_id || execution.final_reviewer.latest_thread_id === execution.implementer.thread_id || solThreads.some((thread) => terraThreads.includes(thread))) throw new ExecutionError("EXECUTION_RECEIPT_INCONSISTENT", "Completed execution receipt is missing matching verification, review, or thread evidence.");
        return execution;
      }
      if (["REPLAN_REQUIRED", "WEB_REVIEW_REQUIRED", "HUMAN_REQUIRED", "POLICY_BLOCKED", "BUDGET_EXHAUSTED", "FAILED"].includes(execution.state)) return execution;
      await writeExecutionReceipt(this.options.stateDirectory, execution);
      if (execution.state === "READY_FOR_CODEX") await this.transition(execution, "CODEX_PREFLIGHT");
      if (!this.options.agentClient) throw new ExecutionError("CODEX_RUNTIME_NOT_FOUND", "A supported Codex runtime client is not configured.");
      if (!this.options.sandbox) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "A supported Codex verification sandbox is not configured.");
      const client = withAgentTimeout(this.options.agentClient, config.agents.limits.maximum_turn_seconds);
      await client.checkAvailability();
      if (this.options.sandbox.checkAvailability) await this.options.sandbox.checkAvailability();
      const limits = config.agents.limits ?? defaultAgentLimits();
      const startedAt = execution.usage.started_at ? Date.parse(execution.usage.started_at) : Date.now();
      const budget = new BudgetTracker({ ...limits, maximum_implementation_iterations: effectiveLimit(limits.maximum_implementation_iterations, contract.limits.max_internal_iterations), maximum_internal_review_rounds: effectiveLimit(limits.maximum_internal_review_rounds, contract.limits.max_review_rounds), maximum_sol_review_rounds: effectiveLimit(limits.maximum_sol_review_rounds, contract.limits.max_review_rounds) }, Number.isFinite(startedAt) ? startedAt : Date.now(), { implementationIterations: execution.implementer.iterations, internalReviewRounds: execution.internal_reviewer.rounds, solReviewRounds: execution.final_reviewer.rounds, totalTurns: execution.usage.total_turns ?? execution.implementer.iterations + execution.internal_reviewer.rounds + execution.final_reviewer.rounds, inputTokens: execution.usage.input_tokens, cachedInputTokens: execution.usage.cached_input_tokens, outputTokens: execution.usage.output_tokens });
      const syncBudget = async (): Promise<void> => {
        execution!.usage.total_turns = budget.usage.totalTurns;
        execution!.usage.started_at = new Date(budget.usage.startedAt).toISOString();
        await writeExecutionReceipt(this.options.stateDirectory, execution!);
      };
      let changeSet: ChangeSet = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
      execution.change_set_sha256 = changeSet.change_set_sha256;
      let pendingReviewerFindings: ReviewFinding[] = [];
      let pendingVerificationFailure: VerificationFailureEvidence | null = execution.pending_verification_failure ?? null;

      if (["POLICY_CHECKING", "VERIFYING", "TERRA_REVIEWING", "SOL_REVIEWING", "VERIFICATION_FAILED", "AGENT_FAILED"].includes(execution.state)) {
        invalidateReviews(execution);
        await this.transition(execution, "TERRA_FIXING", { reason: "resume-from-intermediate-state" });
      } else if (execution.state === "INTERRUPTED") {
        await this.transition(execution, changeSet.entries.length === 0 ? "CODEX_PREFLIGHT" : "TERRA_FIXING", { reason: "resume-after-interruption" });
      }

      if (execution.state === "CODEX_PREFLIGHT" || execution.state === "TERRA_ASSESSING") {
        throwIfAborted(this.options.signal);
        if (execution.state === "CODEX_PREFLIGHT") await this.transition(execution, "TERRA_ASSESSING");
        await syncBudget();
        const before = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        let assessed: Awaited<ReturnType<typeof assessWithTerra>>;
        try {
          budget.beginAssessment(); await syncBudget();
          assessed = await assessWithTerra(client, { model: execution.implementer.model, reasoning_effort: execution.implementer.reasoning_effort, threadId: execution.implementer.thread_id || undefined, workspacePath: execution.worktree_path, acceptedBundlePath: preparation.accepted_bundle_path, prompt: `${boundedPromptText(bundleData.request)}\n\nPlan:\n${boundedPromptText(bundleData.plan)}\n\nRules:\n${boundedPromptText(bundleData.rules)}\n\nAcceptance:\n${boundedPromptJson(bundleData.acceptance)}\n\nTest matrix:\n${boundedPromptJson(bundleData.testMatrix)}\n\nValidation contract:\n${boundedPromptJson(bundleData.validation)}\n\nRisk policy:\n${boundedPromptJson(bundleData.riskPolicy)}`, ...(this.options.signal ? { signal: this.options.signal } : {}) });
        } catch (error) {
          if (!isExecutionError(error) || error.code !== "AGENT_OUTPUT_INVALID") throw error;
          await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
          budget.beginRepair(); await syncBudget();
          const repair = await assessWithTerra(client, { model: execution.implementer.model, reasoning_effort: execution.implementer.reasoning_effort, threadId: execution.implementer.thread_id, workspacePath: execution.worktree_path, acceptedBundlePath: preparation.accepted_bundle_path, prompt: "Your previous response was invalid. Return exactly the required assessment JSON and no other fields.", ...(this.options.signal ? { signal: this.options.signal } : {}) });
          assessed = repair;
        }
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        const after = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        if (before.change_set_sha256 !== after.change_set_sha256) throw new ExecutionError("AGENT_ASSESSMENT_MUTATED_WORKTREE", "Terra assessment changed the worktree.");
        execution.implementer.thread_id = assessed.response.thread_id;
        await writeExecutionReceipt(this.options.stateDirectory, execution);
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "implementation", assessed.assessment, "assessment.json");
        await appendAgentEvent(this.options.stateDirectory, taskId, archiveSha256, { event_version: "1.0", role: "implementer", phase: "assessment", thread_id: assessed.response.thread_id, prompt_sha256: "redacted", usage: assessed.response.usage ?? {} });
        execution.usage.input_tokens += assessed.response.usage?.input_tokens ?? 0; execution.usage.cached_input_tokens += assessed.response.usage?.cached_input_tokens ?? 0; execution.usage.output_tokens += assessed.response.usage?.output_tokens ?? 0;
        budget.recordTokens(assessed.response.usage?.input_tokens, assessed.response.usage?.output_tokens, assessed.response.usage?.cached_input_tokens ?? 0);
        await syncBudget();
        if (assessed.assessment.status === "REPLAN_REQUIRED") { await this.transition(execution, "REPLAN_REQUIRED"); execution.errors.push({ code: "REPLAN_REQUIRED", message: redact(assessed.assessment.summary).slice(0, 16_384) }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        if (assessed.assessment.status === "HUMAN_REQUIRED") { await this.transition(execution, "HUMAN_REQUIRED"); execution.errors.push({ code: "HUMAN_REQUIRED", message: redact(assessed.assessment.summary).slice(0, 16_384) }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        if (assessed.assessment.status === "BLOCKED") { await this.transition(execution, "POLICY_BLOCKED"); execution.errors.push({ code: "POLICY_BLOCKED", message: redact(assessed.assessment.summary).slice(0, 16_384) }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        await this.transition(execution, "TERRA_IMPLEMENTING");
      }

      while (execution.state === "TERRA_IMPLEMENTING" || execution.state === "TERRA_FIXING") {
        throwIfAborted(this.options.signal);
        budget.beginImplementation(); execution.implementer.iterations += 1;
        if (execution.state === "TERRA_FIXING") await this.transition(execution, "TERRA_IMPLEMENTING");
        await syncBudget();
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        let implemented: Awaited<ReturnType<typeof implementWithTerra>>;
        try {
          implemented = await implementWithTerra(client, { model: execution.implementer.model, reasoning_effort: execution.implementer.reasoning_effort, threadId: execution.implementer.thread_id, workspacePath: execution.worktree_path, acceptedBundlePath: preparation.accepted_bundle_path, prompt: `${boundedPromptText(bundleData.request)}\n\nPlan:\n${boundedPromptText(bundleData.plan)}\n\nRules:\n${boundedPromptText(bundleData.rules)}\n\nAcceptance:\n${boundedPromptJson(bundleData.acceptance)}\n\nTest matrix:\n${boundedPromptJson(bundleData.testMatrix)}\n\nValidation contract:\n${boundedPromptJson(bundleData.validation)}\n\nRisk policy:\n${boundedPromptJson(bundleData.riskPolicy)}\n\nValidated reviewer findings to fix:\n${boundedPromptJson(pendingReviewerFindings)}\n\nDeterministic verifier failure evidence to fix:\n${boundedPromptJson(pendingVerificationFailure)}\n\nCurrent exact change-set digest: ${execution.change_set_sha256 ?? ""}`, ...(this.options.signal ? { signal: this.options.signal } : {}) });
        } catch (error) {
          if (!isExecutionError(error) || error.code !== "AGENT_OUTPUT_INVALID") throw error;
          await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
          budget.beginRepair(); await syncBudget();
          implemented = await implementWithTerra(client, { model: execution.implementer.model, reasoning_effort: execution.implementer.reasoning_effort, threadId: execution.implementer.thread_id, workspacePath: execution.worktree_path, acceptedBundlePath: preparation.accepted_bundle_path, prompt: "Your previous implementation response was invalid. Return exactly the required implementation JSON and no other fields.", ...(this.options.signal ? { signal: this.options.signal } : {}) });
        }
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        execution.implementer.thread_id = implemented.response.thread_id;
        await appendAgentEvent(this.options.stateDirectory, taskId, archiveSha256, { event_version: "1.0", role: "implementer", phase: "implementation", thread_id: implemented.response.thread_id, prompt_sha256: "redacted", usage: implemented.response.usage ?? {} });
        execution.usage.input_tokens += implemented.response.usage?.input_tokens ?? 0; execution.usage.cached_input_tokens += implemented.response.usage?.cached_input_tokens ?? 0; execution.usage.output_tokens += implemented.response.usage?.output_tokens ?? 0;
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "implementation", implemented.implementation, `iteration-${String(execution.implementer.iterations).padStart(3, "0")}.json`);
        budget.recordTokens(implemented.response.usage?.input_tokens, implemented.response.usage?.output_tokens, implemented.response.usage?.cached_input_tokens ?? 0);
        await syncBudget();
        if (implemented.implementation.status === "REPLAN_REQUIRED") { await this.transition(execution, "REPLAN_REQUIRED"); execution.errors.push({ code: "REPLAN_REQUIRED", message: redact(implemented.implementation.summary).slice(0, 16_384) }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        if (implemented.implementation.status === "HUMAN_REQUIRED") { await this.transition(execution, "HUMAN_REQUIRED"); execution.errors.push({ code: "HUMAN_REQUIRED", message: redact(implemented.implementation.summary).slice(0, 16_384) }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        if (implemented.implementation.status === "BLOCKED") { await this.transition(execution, "POLICY_BLOCKED"); execution.errors.push({ code: "POLICY_BLOCKED", message: redact(implemented.implementation.summary).slice(0, 16_384) }); await writeExecutionReceipt(this.options.stateDirectory, execution); return execution; }
        pendingReviewerFindings = [];
        pendingVerificationFailure = null;
        execution.pending_verification_failure = null;
        await writeExecutionReceipt(this.options.stateDirectory, execution);
        changeSet = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        const trustedMaximumChangedFiles = config.verification.maximum_changed_files ?? 100;
        const trustedMaximumDiffLines = config.verification.maximum_diff_lines ?? 10_000;
        await enforcePathPolicy({ worktreePath: execution.worktree_path, allowedPaths: contract.allowed_paths, forbiddenPaths: contract.forbidden_paths, maximumChangedFiles: effectiveLimit(trustedMaximumChangedFiles, contract.limits.max_changed_files), maximumDiffLines: effectiveLimit(trustedMaximumDiffLines, contract.limits.max_diff_lines), maximumFileBytes: config.verification.maximum_file_bytes, expectedRefsSha256: execution.repository_refs_sha256 ?? undefined, allowedGeneratedPaths: config.verification.allowed_generated_paths }, changeSet);
        execution.change_set_sha256 = changeSet.change_set_sha256;
        await this.transition(execution, "POLICY_CHECKING");
        await this.transition(execution, "VERIFYING");
        const verification = await verifyDeterministically({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, validation: bundleData.validation, policy: config.verification, sandbox: this.options.sandbox, runner, signal: this.options.signal, now, expectedRefsSha256: execution.repository_refs_sha256 ?? undefined });
        execution.verification.rounds += 1; execution.verification.required_commands_passed = verification.required_commands_passed; execution.verification.commands = verification.commands; execution.verification.verified_change_set_sha256 = verification.changeSet.change_set_sha256; execution.change_set_sha256 = verification.changeSet.change_set_sha256;
        const verificationDirectory = `round-${String(execution.verification.rounds).padStart(3, "0")}`;
        for (const command of execution.verification.commands) {
          const safeId = command.command_id.replace(/[^A-Za-z0-9._-]/g, "_");
          command.stdout_log_path = `verification/${verificationDirectory}/${safeId}.stdout.log`;
          command.stderr_log_path = `verification/${verificationDirectory}/${safeId}.stderr.log`;
          await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "verification", command, `${verificationDirectory}/${safeId}.json`);
          await writeExecutionText(this.options.stateDirectory, taskId, archiveSha256, "verification", command.stdout ?? "", `${verificationDirectory}/${safeId}.stdout.log`);
          await writeExecutionText(this.options.stateDirectory, taskId, archiveSha256, "verification", command.stderr ?? "", `${verificationDirectory}/${safeId}.stderr.log`);
        }
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "verification", verification, `${verificationDirectory}/summary.json`);
        if (!verification.required_commands_passed) {
          const failed = verification.commands.filter((command) => command.required && command.status !== "PASS");
          pendingVerificationFailure = {
            verification_round: execution.verification.rounds,
            failed_command_ids: failed.map((command) => command.command_id),
            commands: failed.map((command) => ({
              command_id: command.command_id,
              status: command.timed_out ? "TIMEOUT" as const : "FAIL" as const,
              exit_code: command.exit_code,
              signal: command.signal,
              timed_out: command.timed_out,
              stdout_tail: redact(command.stdout ?? "").slice(-8_192),
              stderr_tail: redact(command.stderr ?? "").slice(-8_192),
            })),
            remaining_implementation_iterations: Math.max(0, limits.maximum_implementation_iterations - execution.implementer.iterations),
          };
          execution.pending_verification_failure = pendingVerificationFailure;
          await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "verification", pendingVerificationFailure, `${verificationDirectory}/fix-evidence.json`);
          await writeExecutionReceipt(this.options.stateDirectory, execution);
          await this.transition(execution, "VERIFICATION_FAILED");
          invalidateReviews(execution);
          if (execution.implementer.iterations >= budget.usage.implementationIterations && budget.usage.implementationIterations >= limits.maximum_implementation_iterations) { await this.transition(execution, "BUDGET_EXHAUSTED"); return execution; }
          await this.transition(execution, "TERRA_FIXING");
          continue;
        }
        await this.transition(execution, "TERRA_REVIEWING");
        throwIfAborted(this.options.signal);
        budget.beginInternalReview();
        await syncBudget();
        const terraBefore = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        const trackedDiff = await boundedTrackedDiff(runner, execution.base_commit, execution.worktree_path);
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        let terra: Awaited<ReturnType<typeof reviewWithTerra>>;
        try {
          terra = await reviewWithTerra(client, { model: execution.internal_reviewer.model, reasoning_effort: execution.internal_reviewer.reasoning_effort, threadId: undefined, workspacePath: execution.worktree_path, acceptedBundlePath: preparation.accepted_bundle_path, prompt: `${boundedPromptText(bundleData.request)}\n\nPlan:\n${boundedPromptText(bundleData.plan)}\n\nRules:\n${boundedPromptText(bundleData.rules)}\n\nAcceptance:\n${boundedPromptJson(bundleData.acceptance)}\n\nTest matrix:\n${boundedPromptJson(bundleData.testMatrix)}\n\nValidation contract:\n${boundedPromptJson(bundleData.validation)}\n\nRisk policy:\n${boundedPromptJson(bundleData.riskPolicy)}\n\nImplementation evidence:\n${boundedPromptJson(implemented.implementation)}\n\nBase commit: ${execution.base_commit}\nBranch: ${execution.branch_name}\nChange-set digest: ${execution.change_set_sha256}\nActual changed paths and hashes: ${boundedPromptJson(changeSet.entries)}\nChange-set metadata: ${boundedPromptJson({ tracked_diff_sha256: changeSet.tracked_diff_sha256, refs_sha256: changeSet.refs_sha256, diff_lines: changeSet.diff_lines })}\nBounded tracked diff:\n${trackedDiff}\nDeterministic verification evidence: ${boundedVerificationEvidence(verification.commands)}\nThe verifier passed. Review only.`, ...(this.options.signal ? { signal: this.options.signal } : {}) });
        } catch (error) {
          if (!isExecutionError(error) || error.code !== "REVIEW_OUTPUT_INVALID") throw error;
          await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
          budget.beginRepair(); await syncBudget();
          terra = await reviewWithTerra(client, { model: execution.internal_reviewer.model, reasoning_effort: execution.internal_reviewer.reasoning_effort, threadId: undefined, workspacePath: execution.worktree_path, acceptedBundlePath: preparation.accepted_bundle_path, prompt: "Your previous review output was invalid. Return exactly the required reviewer JSON and no other fields.", ...(this.options.signal ? { signal: this.options.signal } : {}) });
        }
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        const terraAfter = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        if (terraBefore.change_set_sha256 !== terraAfter.change_set_sha256) throw new ExecutionError("TERRA_REVIEW_MUTATED_WORKTREE", "Terra reviewer changed the worktree.");
        if (terraAfter.change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("TERRA_REVIEW_STALE", "The worktree changed while Terra reviewed it.");
        const terraReview = terra.review;
        const existingTerraThreads = execution.internal_reviewer.thread_ids ?? (execution.internal_reviewer.latest_thread_id ? [execution.internal_reviewer.latest_thread_id] : []);
        const existingSolThreadsForTerra = execution.final_reviewer.thread_ids ?? (execution.final_reviewer.latest_thread_id ? [execution.final_reviewer.latest_thread_id] : []);
        if (!terra.threadId || terra.threadId === execution.implementer.thread_id || existingTerraThreads.includes(terra.threadId) || existingSolThreadsForTerra.includes(terra.threadId)) throw new ExecutionError("TERRA_REVIEW_OUTPUT_INVALID", "Terra reviewer must return a fresh independent thread.");
        execution.internal_reviewer.thread_ids = [...existingTerraThreads, terra.threadId];
        execution.internal_reviewer.latest_thread_id = terra.threadId;
        execution.internal_reviewer.rounds += 1;
        execution.internal_reviewer.verdict = terraReview.verdict;
        execution.internal_reviewer.reviewed_change_set_sha256 = terraReview.reviewed_change_set_sha256;
        execution.usage.input_tokens += terra.response.usage?.input_tokens ?? 0; execution.usage.cached_input_tokens += terra.response.usage?.cached_input_tokens ?? 0; execution.usage.output_tokens += terra.response.usage?.output_tokens ?? 0;
        budget.recordTokens(terra.response.usage?.input_tokens, terra.response.usage?.output_tokens, terra.response.usage?.cached_input_tokens ?? 0);
        await syncBudget();
        assertAcceptanceResults(terraReview, allAcceptanceIds, "TERRA_REVIEW_OUTPUT_INVALID");
        await validateReviewFindings(terraReview, execution.worktree_path, "TERRA_REVIEW_OUTPUT_INVALID");
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "terra-review", terraReview, `round-${String(execution.internal_reviewer.rounds).padStart(3, "0")}/verdict.json`);
        await appendAgentEvent(this.options.stateDirectory, taskId, archiveSha256, { event_version: "1.0", role: "internal_reviewer", phase: "review", thread_id: terra.threadId, prompt_sha256: "redacted", usage: terra.response?.usage ?? {} });
        if (terraReview.reviewed_change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("TERRA_REVIEW_STALE", "Terra review digest is stale.");
        if (terraReview.verdict === "REVISE") { pendingReviewerFindings = [...terraReview.blocking_findings]; pendingVerificationFailure = null; execution.pending_verification_failure = null; invalidateReviews(execution); await writeExecutionReceipt(this.options.stateDirectory, execution); await this.transition(execution, "TERRA_FIXING"); continue; }
        if (terraReview.verdict === "REPLAN") { await this.transition(execution, "WEB_REVIEW_REQUIRED"); return execution; }
        if (terraReview.verdict === "ESCALATE") { await this.transition(execution, "HUMAN_REQUIRED"); return execution; }
        assertTerraCanStart(execution, terraReview, requiredAcceptanceIds);
        await this.transition(execution, "SOL_REVIEWING");
        throwIfAborted(this.options.signal);
        budget.beginSolReview();
        await syncBudget();
        assertSolCanStart(execution, terraReview, requiredAcceptanceIds);
        const terraThreadIds = execution.internal_reviewer.thread_ids ?? (execution.internal_reviewer.latest_thread_id ? [execution.internal_reviewer.latest_thread_id] : []);
        const solBefore = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        const solTrackedDiff = await boundedTrackedDiff(runner, execution.base_commit, execution.worktree_path);
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        let sol: Awaited<ReturnType<typeof reviewWithSol>>;
        try {
          sol = await reviewWithSol(client, { model: execution.final_reviewer.model, reasoning_effort: execution.final_reviewer.reasoning_effort, threadId: undefined, workspacePath: execution.worktree_path, acceptedBundlePath: preparation.accepted_bundle_path, prompt: `${boundedPromptText(bundleData.request)}\n\nPlan:\n${boundedPromptText(bundleData.plan)}\n\nRules:\n${boundedPromptText(bundleData.rules)}\n\nAcceptance:\n${boundedPromptJson(bundleData.acceptance)}\n\nTest matrix:\n${boundedPromptJson(bundleData.testMatrix)}\n\nValidation contract:\n${boundedPromptJson(bundleData.validation)}\n\nRisk policy:\n${boundedPromptJson(bundleData.riskPolicy)}\n\nImplementation evidence:\n${boundedPromptJson(implemented.implementation)}\n\nBase commit: ${execution.base_commit}\nBranch: ${execution.branch_name}\nChange-set digest: ${execution.change_set_sha256}\nActual changed paths and hashes: ${boundedPromptJson(changeSet.entries)}\nChange-set metadata: ${boundedPromptJson({ tracked_diff_sha256: changeSet.tracked_diff_sha256, refs_sha256: changeSet.refs_sha256, diff_lines: changeSet.diff_lines })}\nBounded tracked diff:\n${solTrackedDiff}\nDeterministic verification evidence: ${boundedVerificationEvidence(verification.commands)}\nTerra review verdict and evidence (not authority): ${boundedPromptJson(terraReview)}\nVerify independently in read-only mode.`, ...(this.options.signal ? { signal: this.options.signal } : {}) });
        } catch (error) {
          if (!isExecutionError(error) || error.code !== "REVIEW_OUTPUT_INVALID") throw error;
          await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
          budget.beginRepair(); await syncBudget();
          sol = await reviewWithSol(client, { model: execution.final_reviewer.model, reasoning_effort: execution.final_reviewer.reasoning_effort, threadId: undefined, workspacePath: execution.worktree_path, acceptedBundlePath: preparation.accepted_bundle_path, prompt: "Your previous review output was invalid. Return exactly the required reviewer JSON and no other fields.", ...(this.options.signal ? { signal: this.options.signal } : {}) });
        }
        await assertBundleUnchanged(preparation.accepted_bundle_path, bundleSnapshot);
        const solAfter = await calculateChangeSet({ worktreePath: execution.worktree_path, baseCommit: execution.base_commit, branchName: execution.branch_name, runner, allowedGeneratedPaths: config.verification.allowed_generated_paths });
        if (solBefore.change_set_sha256 !== solAfter.change_set_sha256) throw new ExecutionError("REVIEW_MUTATED_WORKTREE", "Sol reviewer changed the worktree.");
        if (solAfter.change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("REVIEW_STALE", "The worktree changed while Sol reviewed it.");
        const solReview = sol.review;
        const existingSolThreads = execution.final_reviewer.thread_ids ?? (execution.final_reviewer.latest_thread_id ? [execution.final_reviewer.latest_thread_id] : []);
        if (!sol.threadId || sol.threadId === execution.implementer.thread_id || terraThreadIds.includes(sol.threadId) || existingSolThreads.includes(sol.threadId)) throw new ExecutionError("SOL_REVIEW_NOT_ALLOWED", "Sol reviewer must return a fresh independent thread.");
        execution.final_reviewer.thread_ids = [...existingSolThreads, sol.threadId];
        execution.final_reviewer.latest_thread_id = sol.threadId;
        execution.final_reviewer.rounds += 1;
        execution.final_reviewer.verdict = solReview.verdict;
        execution.final_reviewer.reviewed_change_set_sha256 = solReview.reviewed_change_set_sha256;
        execution.usage.input_tokens += sol.response.usage?.input_tokens ?? 0; execution.usage.cached_input_tokens += sol.response.usage?.cached_input_tokens ?? 0; execution.usage.output_tokens += sol.response.usage?.output_tokens ?? 0;
        budget.recordTokens(sol.response.usage?.input_tokens, sol.response.usage?.output_tokens, sol.response.usage?.cached_input_tokens ?? 0);
        await syncBudget();
        assertAcceptanceResults(solReview, allAcceptanceIds, "REVIEW_OUTPUT_INVALID");
        await validateReviewFindings(solReview, execution.worktree_path, "REVIEW_OUTPUT_INVALID");
        await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "sol-review", solReview, `round-${String(execution.final_reviewer.rounds).padStart(3, "0")}/verdict.json`);
        await appendAgentEvent(this.options.stateDirectory, taskId, archiveSha256, { event_version: "1.0", role: "final_reviewer", phase: "review", thread_id: sol.threadId, prompt_sha256: "redacted", usage: sol.response?.usage ?? {} });
        if (solReview.reviewed_change_set_sha256 !== execution.change_set_sha256) throw new ExecutionError("REVIEW_STALE", "Sol review digest is stale.");
        if (solReview.verdict === "REVISE") { pendingReviewerFindings = [...solReview.blocking_findings]; pendingVerificationFailure = null; execution.pending_verification_failure = null; invalidateReviews(execution); await writeExecutionReceipt(this.options.stateDirectory, execution); await this.transition(execution, "TERRA_FIXING"); continue; }
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
      if (execution) {
        if (isExecutionError(error) && error.code === "VERIFIER_TIMEOUT" && error.details?.command && typeof error.details.command === "object") {
          const timedCommand = error.details.command as VerificationCommandResult;
          const completedCommands = Array.isArray(error.details.commands) ? error.details.commands.filter((item): item is VerificationCommandResult => Boolean(item && typeof item === "object" && typeof (item as { command_id?: unknown }).command_id === "string")) : [timedCommand];
          execution.verification.rounds += 1;
          const roundDirectory = `round-${String(execution.verification.rounds).padStart(3, "0")}`;
          for (const command of completedCommands) {
            const safeId = command.command_id.replace(/[^A-Za-z0-9._-]/g, "_");
            command.stdout_log_path = `verification/${roundDirectory}/${safeId}.stdout.log`;
            command.stderr_log_path = `verification/${roundDirectory}/${safeId}.stderr.log`;
          }
          execution.verification.commands = completedCommands;
          execution.verification.required_commands_passed = false;
          execution.verification.verified_change_set_sha256 = null;
          const failed = completedCommands.filter((command) => command.required && command.status !== "PASS");
          execution.pending_verification_failure = {
            verification_round: execution.verification.rounds,
            failed_command_ids: failed.map((command) => command.command_id),
            commands: failed.map((command) => ({
              command_id: command.command_id,
              status: command.timed_out ? "TIMEOUT" as const : "FAIL" as const,
              exit_code: command.exit_code,
              signal: command.signal,
              timed_out: command.timed_out,
              stdout_tail: redact(command.stdout ?? "").slice(-8_192),
              stderr_tail: redact(command.stderr ?? "").slice(-8_192),
            })),
            remaining_implementation_iterations: 0,
          };
          await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "verification", execution.pending_verification_failure, `${roundDirectory}/fix-evidence.json`).catch(() => undefined);
          for (const command of completedCommands) {
            const safeId = command.command_id.replace(/[^A-Za-z0-9._-]/g, "_");
            await writeExecutionArtifact(this.options.stateDirectory, taskId, archiveSha256, "verification", command, `${roundDirectory}/${safeId}.json`).catch(() => undefined);
            await writeExecutionText(this.options.stateDirectory, taskId, archiveSha256, "verification", command.stdout ?? "", `${roundDirectory}/${safeId}.stdout.log`).catch(() => undefined);
            await writeExecutionText(this.options.stateDirectory, taskId, archiveSha256, "verification", command.stderr ?? "", `${roundDirectory}/${safeId}.stderr.log`).catch(() => undefined);
          }
        }
        execution.errors.push({ code, message }); if (!["READY_FOR_PUBLISH", "REPLAN_REQUIRED", "HUMAN_REQUIRED", "WEB_REVIEW_REQUIRED", "POLICY_BLOCKED", "BUDGET_EXHAUSTED", "INTERRUPTED", "VERIFICATION_FAILED", "AGENT_FAILED"].includes(execution.state)) { const terminal = code === "BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : code === "INTERRUPTED" ? "INTERRUPTED" : ["EXECUTION_SCHEMA_UPGRADE_REQUIRED", "EXECUTION_CONTRACT_REQUIRED", "DELIVERY_CONTRACT_INVALID", "GIT_POLICY_INVALID", "BASE_COMMIT_INVALID", "BRANCH_POLICY_VIOLATION", "VALIDATION_CONTRACT_INVALID", "VALIDATION_EXECUTABLE_DENIED", "VALIDATION_ENVIRONMENT_DENIED", "VALIDATION_CWD_UNSAFE", "PATH_POLICY_VIOLATION", "FORBIDDEN_PATH_CHANGED", "CHANGE_LIMIT_EXCEEDED", "SYMLINK_CHANGE_NOT_ALLOWED", "SPECIAL_FILE_CHANGE_NOT_ALLOWED", "SUBMODULE_CHANGE_NOT_ALLOWED", "BINARY_CHANGE_NOT_ALLOWED"].includes(code) ? "POLICY_BLOCKED" : ["AGENT_OUTPUT_INVALID", "AGENT_ASSESSMENT_MUTATED_WORKTREE", "AGENT_COMMITTED_CHANGES", "AGENT_CHANGED_BRANCH", "BUNDLE_MUTATED", "TERRA_REVIEW_OUTPUT_INVALID", "REVIEW_OUTPUT_INVALID", "TERRA_REVIEW_MUTATED_WORKTREE", "REVIEW_MUTATED_WORKTREE", "CODEX_TURN_FAILED", "CODEX_TURN_TIMEOUT"].includes(code) ? "AGENT_FAILED" : ["VERIFIER_TIMEOUT", "VERIFIER_OUTPUT_LIMIT", "VERIFIER_MUTATED_SOURCE", "VERIFICATION_FAILED"].includes(code) ? "VERIFICATION_FAILED" : "FAILED"; try { await this.transition(execution, terminal); } catch { execution.state = terminal; } } await writeExecutionReceipt(this.options.stateDirectory, execution).catch(() => undefined);
      }
      throw error;
    } finally { await lock.release(); }
  }
}

export async function executeRun(options: ExecutionOptions): Promise<ExecutionReceipt> { return new ExecutionService(options).execute(); }

export const executePhase4 = executeRun;
