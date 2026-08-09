import path from "node:path";
import { CodexSdkAgentClient } from "../agent/codex-sdk-client.js";
import { reviewWithSol } from "../agent/sol-reviewer.js";
import { reviewWithTerra } from "../agent/terra-reviewer.js";
import { loadPhase4Config } from "../execution/execution-config.js";
import { resolveCodexRuntime } from "../runtime/codex-runtime.js";
import { CodexVerificationSandbox } from "../verifier/codex-sandbox.js";
import { verifyDeterministically } from "../verifier/verifier.js";
import { readBoundedStableAuthorityFile } from "../web-authority/task-spec-authority.js";
import { resolveTrustedRunContext } from "../web-review/trusted-run-context.js";
import { ExecutorError, type ExecutorUsage } from "./contracts.js";
import type { ExecutorReviewerPort, ExecutorReviewRequest, ExecutorVerifierPort, ExecutorVerificationRequest } from "./gates.js";

const MAX_REVIEW_PROMPT_BYTES = 64 * 1024;
const MAX_COMMAND_TAIL_CHARS = 4096;
const MAX_VALIDATION_BYTES = 8 * 1024 * 1024;

function tail(value: string | undefined): string {
  if (!value) return "";
  return value.length <= MAX_COMMAND_TAIL_CHARS ? value : value.slice(value.length - MAX_COMMAND_TAIL_CHARS);
}

function boundedTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function reviewUsage(usage: { input_tokens?: number; output_tokens?: number } | undefined): ExecutorUsage {
  return {
    model_turns: 1,
    input_tokens: boundedTokenCount(usage?.input_tokens),
    output_tokens: boundedTokenCount(usage?.output_tokens),
  };
}

async function loadValidationDocument(acceptedBundlePath: string): Promise<unknown> {
  try {
    const bytes = await readBoundedStableAuthorityFile(path.join(acceptedBundlePath, "validation.json"), MAX_VALIDATION_BYTES, "WEB_AUTHORITY_BINDING_MISMATCH", "accepted validation.json");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new ExecutorError("EXECUTOR_CANONICAL_AUTHORITY_DRIFT", `Accepted validation authority is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function reviewPrompt(request: ExecutorReviewRequest): string {
  const context = request.context_selection;
  const body = [
    "Review the exact Phase 10 result in read-only mode.",
    "The Web implementation pack is already the architecture/implementation authority; do not redesign or modify files.",
    `Required reviewed_change_set_sha256: ${request.change_set_digest}`,
    `Registered artifact SHA-256: ${request.artifact_sha256}`,
    `Changed paths (${request.changed_paths.length}):`,
    ...request.changed_paths.map((filePath) => `- ${filePath}`),
    `Deterministic context selection: ${context.selection_sha256}`,
    `Context source: ${context.source}; candidates=${context.candidate_count}; selected=${context.paths.length}; truncated=${context.truncated}`,
    "Priority context paths (hints only; not lifecycle, architecture, or acceptance authority):",
    ...(context.paths.length > 0 ? context.paths.map((filePath) => `- ${filePath}`) : ["- none"]),
    "Start with the changed files and these priority context paths. Expand reads only when necessary to verify a concrete dependency or finding.",
    "Use the accepted Task Bundle as the requirement/acceptance source of truth.",
    "Focus on correctness, security, regressions, tests, scope and performance.",
    "If a blocking correction is needed return REVISE; if authority/requirements are insufficient return ESCALATE. Never edit the worktree.",
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_REVIEW_PROMPT_BYTES) throw new ExecutorError("EXECUTOR_OPERATIONAL_ERROR", `Phase 10 review prompt exceeds ${MAX_REVIEW_PROMPT_BYTES} bytes.`);
  return body;
}

function mappedVerdict(verdict: string): "APPROVE" | "REVISE" | "ESCALATE" {
  if (verdict === "APPROVE") return "APPROVE";
  if (verdict === "REVISE") return "REVISE";
  return "ESCALATE";
}

export async function createProductionExecutorGates(options: { runId: string; stateDirectory: string; configPath: string }): Promise<{ verifier: ExecutorVerifierPort; reviewer: ExecutorReviewerPort }> {
  const [config, trusted] = await Promise.all([
    loadPhase4Config(options.configPath),
    resolveTrustedRunContext(options.runId, options.stateDirectory, options.configPath),
  ]);
  const runtime = await resolveCodexRuntime(config.runtime, options.stateDirectory);
  const agentClient = new CodexSdkAgentClient(runtime);
  const sandbox = new CodexVerificationSandbox(runtime);
  // Fail before product mutation when local auth or the verifier sandbox is unusable.
  await Promise.all([agentClient.checkAvailability(), sandbox.checkAvailability()]);
  // Phase 10 needs only the deterministic validation contract here. Avoid the
  // Phase 4 broad bundle reader so normal execution does not deserialize
  // unrelated plan/request/test-matrix documents solely to run verification.
  const validation = await loadValidationDocument(trusted.runReceipt.accepted_bundle_path);

  const verifier: ExecutorVerifierPort = {
    async verify(request: ExecutorVerificationRequest) {
      const result = await verifyDeterministically({
        worktreePath: request.worktree_path,
        baseCommit: trusted.runReceipt.base_commit,
        branchName: trusted.runReceipt.branch_name,
        validation,
        policy: config.verification,
        sandbox,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return {
        passed: result.required_commands_passed,
        evidence: {
          kind: "phase10-deterministic-verification",
          change_set_digest: request.change_set_digest,
          required_commands_passed: result.required_commands_passed,
          commands: result.commands.map((command) => ({
            command_id: command.command_id,
            required: command.required,
            status: command.status,
            exit_code: command.exit_code,
            timed_out: command.timed_out,
            duration_ms: command.duration_ms,
            stdout_truncated: command.stdout_truncated,
            stderr_truncated: command.stderr_truncated,
            stdout_tail: tail(command.stdout),
            stderr_tail: tail(command.stderr),
          })),
        },
      };
    },
  };

  const reviewer: ExecutorReviewerPort = {
    async review(request: ExecutorReviewRequest) {
      const prompt = reviewPrompt(request);
      const profile = request.reviewer === "terra" ? config.agents.internal_reviewer : config.agents.final_reviewer;
      const result = request.reviewer === "terra"
        ? await reviewWithTerra(agentClient, { model: profile.model, reasoning_effort: profile.reasoning_effort, prompt, threadId: undefined, workspacePath: request.worktree_path, acceptedBundlePath: request.accepted_bundle_path, ...(request.signal ? { signal: request.signal } : {}) })
        : await reviewWithSol(agentClient, { model: profile.model, reasoning_effort: profile.reasoning_effort, prompt, threadId: undefined, workspacePath: request.worktree_path, acceptedBundlePath: request.accepted_bundle_path, ...(request.signal ? { signal: request.signal } : {}) });
      if (result.review.reviewed_change_set_sha256 !== request.change_set_digest) throw new ExecutorError("EXECUTOR_REVIEW_REJECTED", `${request.reviewer} reviewed stale digest '${result.review.reviewed_change_set_sha256}'.`);
      return {
        verdict: mappedVerdict(result.review.verdict),
        usage: reviewUsage(result.response.usage),
        evidence: {
          kind: `phase10-${request.reviewer}-review`,
          reviewer: request.reviewer,
          change_set_digest: request.change_set_digest,
          context_selection_sha256: request.context_selection.selection_sha256,
          context_source: request.context_selection.source,
          context_paths: request.context_selection.paths,
          context_candidate_count: request.context_selection.candidate_count,
          context_truncated: request.context_selection.truncated,
          verdict: result.review.verdict,
          summary: result.review.summary,
          acceptance_results: result.review.acceptance_results,
          blocking_findings: result.review.blocking_findings,
          non_blocking_findings: result.review.non_blocking_findings,
          scope_violations: result.review.scope_violations,
          unverified_acceptance: result.review.unverified_acceptance,
          usage: result.response.usage ?? null,
        },
      };
    },
  };
  return { verifier, reviewer };
}
