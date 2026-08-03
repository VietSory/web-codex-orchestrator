import type { AgentClient, AgentTurnResponse } from "./contracts.js";
import { buildPrompt } from "./prompt-builder.js";
import { validateAssessment, validateImplementation } from "./output-validator.js";
import type { AgentAssessment, AgentImplementationResult } from "../execution/contracts.js";
import { ASSESSMENT_OUTPUT_SCHEMA, IMPLEMENTATION_OUTPUT_SCHEMA } from "./output-schemas.js";

export async function assessWithTerra(client: AgentClient, request: { model: string; reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh"; prompt: string; threadId: string | undefined; workspacePath: string; acceptedBundlePath: string; signal?: AbortSignal }): Promise<{ response: AgentTurnResponse; assessment: AgentAssessment }> {
  const response = await client.turn({ role: "implementer", model: request.model, reasoning_effort: request.reasoning_effort, ...(request.threadId ? { thread_id: request.threadId } : {}), prompt: buildPrompt({ request: request.prompt, instruction: "Read-only assessment. Read AGENTS.md and the accepted bundle contracts, inspect the repository, inspect payload source without executing it, and return only the required JSON assessment." }), output_schema: ASSESSMENT_OUTPUT_SCHEMA, read_only: true, approval_policy: "never", sandbox_mode: "read-only", network_access: false, live_web_search: false, cached_web_search: false, workspace_path: request.workspacePath, accepted_bundle_path: request.acceptedBundlePath, ...(request.signal ? { signal: request.signal } : {}) });
  return { response, assessment: validateAssessment(response.output) };
}

export async function implementWithTerra(client: AgentClient, request: { model: string; reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh"; prompt: string; threadId: string; workspacePath: string; acceptedBundlePath: string; signal?: AbortSignal }): Promise<{ response: AgentTurnResponse; implementation: AgentImplementationResult }> {
  const response = await client.turn({ role: "implementer", model: request.model, reasoning_effort: request.reasoning_effort, thread_id: request.threadId, prompt: buildPrompt({ request: request.prompt, instruction: "Implement only within the supplied worktree. Do not commit, push, use network, execute payloads, or read secrets. Return only the required JSON." }), output_schema: IMPLEMENTATION_OUTPUT_SCHEMA, read_only: false, approval_policy: "never", sandbox_mode: "workspace-write", network_access: false, live_web_search: false, cached_web_search: false, workspace_path: request.workspacePath, accepted_bundle_path: request.acceptedBundlePath, ...(request.signal ? { signal: request.signal } : {}) });
  return { response, implementation: validateImplementation(response.output) };
}
