import { ChatGptBrowserReviewerAgentClient } from "../agent/chatgpt-browser-reviewer-client.js";
import { reviewWithTerra } from "../agent/terra-reviewer.js";
import { loadPhase4Config } from "../execution/execution-config.js";
import { ExecutorError, type ExecutorUsage } from "./contracts.js";
import type { ExecutorReviewerPort, ExecutorReviewRequest } from "./gates.js";
import { reviewPrompt } from "./production-gates.js";

const BROWSER_REVIEW_MODEL = "chatgpt-web";
const BROWSER_REVIEW_REASONING = "high" as const;

function mappedVerdict(verdict: string): "APPROVE" | "REVISE" | "ESCALATE" {
  if (verdict === "APPROVE") return "APPROVE";
  if (verdict === "REVISE") return "REVISE";
  return "ESCALATE";
}

function browserUsage(): ExecutorUsage {
  // ChatGPT Web does not expose token telemetry. Model-turn count is reserved
  // durably by the executor budget policy before the call; token counters stay
  // zero as an unavailable-observation sentinel for this personal transport.
  return { model_turns: 0, input_tokens: 0, output_tokens: 0 };
}

/**
 * Create the one independent pre-publish reviewer used by browser PAIR.
 *
 * The reviewer runs in a fresh ChatGPT Web conversation, sees only the bounded
 * accepted-bundle/repository context attachment, can propose one bounded repair
 * set, and never receives worktree mutation or Git publication authority.
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
    budget_policy: {
      maximum_model_turns: 1,
      maximum_elapsed_ms: config.agents.limits.maximum_total_seconds * 1_000,
      maximum_input_tokens: config.agents.limits.maximum_total_input_tokens,
      maximum_output_tokens: config.agents.limits.maximum_total_output_tokens,
    },
    async review(request: ExecutorReviewRequest) {
      if (request.reviewer !== "terra") {
        throw new ExecutorError("EXECUTOR_STATE_INVALID", "Browser PAIR uses exactly one independent ChatGPT Web reviewer.");
      }

      const result = await reviewWithTerra(client, {
        model: BROWSER_REVIEW_MODEL,
        reasoning_effort: BROWSER_REVIEW_REASONING,
        prompt: reviewPrompt(request),
        threadId: undefined,
        workspacePath: request.worktree_path,
        acceptedBundlePath: request.accepted_bundle_path,
        deletedPaths: request.deleted_paths ?? [],
        ...(request.signal ? { signal: request.signal } : {}),
      });

      const digestMatches = result.review.reviewed_change_set_sha256 === request.change_set_digest;
      const repairOperations = result.review.repair_operations ?? [];
      const proposalValidForVerdict = result.review.verdict === "REVISE"
        ? repairOperations.length > 0
        : repairOperations.length === 0;

      return {
        verdict: digestMatches && proposalValidForVerdict ? mappedVerdict(result.review.verdict) : "ESCALATE",
        usage: browserUsage(),
        ...(digestMatches && proposalValidForVerdict && result.review.verdict === "REVISE"
          ? { repair_operations: repairOperations }
          : {}),
        evidence: {
          kind: "harness-chatgpt-web-review",
          reviewer: "chatgpt-web",
          model: BROWSER_REVIEW_MODEL,
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
