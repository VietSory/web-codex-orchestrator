import type { AgentClient } from "./contracts.js";
import { buildPrompt } from "./prompt-builder.js";
import { validateReview } from "./output-validator.js";
import type { ReviewResult } from "../execution/contracts.js";
import { REVIEW_OUTPUT_SCHEMA } from "./output-schemas.js";
import { assertSeniorReviewConsistency, assertSeniorReviewFindingLocations, SENIOR_DIFF_REVIEW_INSTRUCTION } from "./reviewer-policy.js";

export async function reviewWithTerra(client: AgentClient, request: { model: string; reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh"; prompt: string; threadId: string | undefined; workspacePath: string; acceptedBundlePath: string; changedPaths?: string[]; signal?: AbortSignal | undefined }): Promise<{ threadId: string; review: ReviewResult; response: Awaited<ReturnType<AgentClient["turn"]>> }> {
  const response = await client.turn({ role: "internal_reviewer", model: request.model, reasoning_effort: request.reasoning_effort, ...(request.threadId ? { thread_id: request.threadId } : {}), prompt: buildPrompt({ request: request.prompt, instruction: SENIOR_DIFF_REVIEW_INSTRUCTION }), output_schema: REVIEW_OUTPUT_SCHEMA, read_only: true, approval_policy: "never", sandbox_mode: "read-only", network_access: false, live_web_search: false, cached_web_search: false, workspace_path: request.workspacePath, accepted_bundle_path: request.acceptedBundlePath, ...(request.signal ? { signal: request.signal } : {}) });
  const review = validateReview(response.output);
  assertSeniorReviewConsistency(review);
  await assertSeniorReviewFindingLocations(review, request.workspacePath, request.changedPaths ?? []);
  return { threadId: response.thread_id, review, response };
}
