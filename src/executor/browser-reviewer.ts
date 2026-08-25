import { ChatGptBrowserReviewerAgentClient } from "../agent/chatgpt-browser-reviewer-client.js";
import { reviewWithTerra } from "../agent/terra-reviewer.js";
import { loadPhase4Config } from "../execution/execution-config.js";
import { ExecutorError, type ExecutorUsage } from "./contracts.js";
import type { ExecutorReviewerPort, ExecutorReviewRequest } from "./gates.js";
import { reviewPrompt } from "./production-gates.js";

const BROWSER_REVIEW_MODEL = "chatgpt-web";
const BROWSER_REVIEW_REASONING = "high" as const;
const GENERIC_REPAIR_PROMPT = "For REVISE, return the complete minimal bounded repair in repair_operations in this same response; there will be no second reviewer call.";

function mappedVerdict(verdict: string): "APPROVE" | "REVISE" | "ESCALATE" {
  if (verdict === "APPROVE") return "APPROVE";
  if (verdict === "REVISE") return "REVISE";
  return "ESCALATE";
}

function browserReviewPrompt(request: ExecutorReviewRequest): string {
  const base = reviewPrompt(request);
  if (!base.includes(GENERIC_REPAIR_PROMPT)) {
    throw new ExecutorError("EXECUTOR_STATE_INVALID", "Browser PAIR review prompt contract changed; refusing to weaken repair reapproval semantics.");
  }
  const replacement = request.final_reapproval
    ? "This is the fresh final reapproval of an already applied and deterministically verified repair. Return APPROVE only if this exact digest is acceptable. Otherwise return ESCALATE. Return repair_operations=[]; no further adaptive repair generation is authorized."
    : "For REVISE, return the complete minimal bounded repair in repair_operations in this same response. Harness may apply and deterministically verify that proposal, but publication remains blocked until a fresh independent ChatGPT Web review APPROVEs the exact repaired digest.";
  return base.replace(GENERIC_REPAIR_PROMPT, replacement);
}

function browserUsage(): ExecutorUsage {
  // ChatGPT Web does not expose token telemetry. Model-turn count is reserved
  // durably by the executor/reapproval budget policy before each call; token
  // counters stay zero as an unavailable-observation sentinel for this transport.
  return { model_turns: 0, input_tokens: 0, output_tokens: 0 };
}

/**
 * Create the independent pre-publish reviewer used by browser PAIR.
 *
 * Every call starts a fresh ChatGPT Web conversation. The initial pass may
 * propose one bounded repair set, but a repaired digest receives a second fresh
 * review and must be APPROVEd exactly before publication. The reviewer never
 * receives worktree mutation or Git publication authority.
 */
export async function createProductionBrowserReviewer(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
}): Promise<ExecutorReviewerPort> {
  const config = await loadPhase4Config(options.configPath);
  const client = new ChatGptBrowserReviewerAgentClient({ stateDirectory: options.stateDirectory });
  await client.checkAvailability();

  return {
    reviewer_kind: "terra",
    reviewer_profile: { model: BROWSER_REVIEW_MODEL, reasoning_effort: BROWSER_REVIEW_REASONING },
    repair_reapproval_required: true,
    budget_policy: {
      maximum_model_turns: 2,
      maximum_elapsed_ms: config.agents.limits.maximum_total_seconds * 1_000,
      maximum_input_tokens: config.agents.limits.maximum_total_input_tokens,
      maximum_output_tokens: config.agents.limits.maximum_total_output_tokens,
    },
    async review(request: ExecutorReviewRequest) {
      if (request.reviewer !== "terra") {
        throw new ExecutorError("EXECUTOR_STATE_INVALID", "Browser PAIR uses exactly one independent ChatGPT Web reviewer role.");
      }

      const result = await reviewWithTerra(client, {
        model: BROWSER_REVIEW_MODEL,
        reasoning_effort: BROWSER_REVIEW_REASONING,
        prompt: browserReviewPrompt(request),
        threadId: undefined,
        workspacePath: request.worktree_path,
        acceptedBundlePath: request.accepted_bundle_path,
        deletedPaths: request.deleted_paths ?? [],
        ...(request.signal ? { signal: request.signal } : {}),
      });

      const digestMatches = result.review.reviewed_change_set_sha256 === request.change_set_digest;
      const repairOperations = result.review.repair_operations ?? [];
      const proposalValidForVerdict = request.final_reapproval
        ? result.review.verdict !== "REVISE" && repairOperations.length === 0
        : result.review.verdict === "REVISE"
          ? repairOperations.length > 0
          : repairOperations.length === 0;
      const acceptedVerdict = request.final_reapproval
        ? result.review.verdict === "APPROVE" ? "APPROVE" as const : "ESCALATE" as const
        : mappedVerdict(result.review.verdict);

      return {
        verdict: digestMatches && proposalValidForVerdict ? acceptedVerdict : "ESCALATE",
        usage: browserUsage(),
        ...(!request.final_reapproval && digestMatches && proposalValidForVerdict && result.review.verdict === "REVISE"
          ? { repair_operations: repairOperations }
          : {}),
        evidence: {
          kind: "harness-chatgpt-web-review",
          reviewer: "chatgpt-web",
          model: BROWSER_REVIEW_MODEL,
          final_reapproval: request.final_reapproval === true,
          change_set_digest: request.change_set_digest,
          reviewed_change_set_sha256: result.review.reviewed_change_set_sha256,
          authority_binding_valid: digestMatches,
          repair_proposal_valid: proposalValidForVerdict,
          repair_operation_count: repairOperations.length,
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
          repair_operations: repairOperations,
          usage: result.response.usage,
        },
      };
    },
  };
}
