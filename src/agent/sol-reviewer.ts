import type { AgentClient } from "./contracts.js";
import { buildPrompt } from "./prompt-builder.js";
import { validateReview } from "./output-validator.js";
import type { ReviewResult } from "../execution/contracts.js";

export async function reviewWithSol(client: AgentClient, request: { model: string; reasoning_effort: string; prompt: string; threadId?: string; workspacePath?: string; acceptedBundlePath?: string; signal?: AbortSignal | undefined }): Promise<{ threadId: string; review: ReviewResult; response: Awaited<ReturnType<AgentClient["turn"]>> }> {
  const response = await client.turn({ role: "final_reviewer", model: request.model, reasoning_effort: request.reasoning_effort, thread_id: request.threadId, prompt: buildPrompt({ request: request.prompt, instruction: "Review independently in read-only mode. Do not modify files. Return only the required JSON." }), read_only: true, approval_policy: "never", sandbox_mode: "read-only", network_access: false, live_web_search: false, cached_web_search: false, workspace_path: request.workspacePath, accepted_bundle_path: request.acceptedBundlePath, signal: request.signal });
  return { threadId: response.thread_id, review: validateReview(response.output), response };
}
