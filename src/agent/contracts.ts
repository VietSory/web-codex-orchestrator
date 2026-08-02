import type { AgentAssessment, AgentImplementationResult, ReviewResult } from "../execution/contracts.js";

export type AgentRole = "implementer" | "internal_reviewer" | "final_reviewer";
export type AgentOutput = AgentAssessment | AgentImplementationResult | ReviewResult;

export interface AgentTurnRequest {
  role: AgentRole;
  model: string;
  reasoning_effort: string;
  thread_id?: string | undefined;
  prompt: string;
  read_only: boolean;
  approval_policy?: "never";
  sandbox_mode?: "read-only" | "workspace-write";
  network_access?: false;
  live_web_search?: false;
  cached_web_search?: false;
  /** Canonical project root granted to the agent by the trusted orchestrator. */
  workspace_path?: string | undefined;
  /** Accepted bundle is read-only context and is never a writable root. */
  accepted_bundle_path?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface AgentTurnResponse {
  thread_id: string;
  output: unknown;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

export interface AgentThread {
  thread_id: string;
}

/**
 * Runtime boundary for Codex.  Implementations own provider-specific thread
 * creation/resume, while the orchestrator only supplies validated requests.
 */
export interface AgentClient {
  /** Resolve the configured runtime and perform a credential-free auth
   * preflight before any model thread is started. */
  checkAvailability(): Promise<void>;
  startThread(request: Omit<AgentTurnRequest, "thread_id">): Promise<AgentThread>;
  resumeThread(threadId: string): Promise<AgentThread>;
  turn(request: AgentTurnRequest): Promise<AgentTurnResponse>;
}
