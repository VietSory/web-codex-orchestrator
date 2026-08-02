import type { AgentClient } from "./contracts.js";
import { buildPrompt } from "./prompt-builder.js";
import { validateReview } from "./output-validator.js";
import type { ReviewResult } from "../execution/contracts.js";

export async function reviewWithTerra(client: AgentClient, request: { model: string; reasoning_effort: string; prompt: string; signal?: AbortSignal | undefined }): Promise<{ threadId: string; review: ReviewResult; response: Awaited<ReturnType<AgentClient["turn"]>> }> {
  const response = await client.turn({ role: "internal_reviewer", model: request.model, reasoning_effort: request.reasoning_effort, prompt: buildPrompt({ request: request.prompt, instruction: "Review read-only. Do not modify files. Return only the required JSON." }), read_only: true, sandbox_mode: "read-only", network_access: false, live_web_search: false, cached_web_search: false, signal: request.signal });
  return { threadId: response.thread_id, review: validateReview(response.output), response };
}
