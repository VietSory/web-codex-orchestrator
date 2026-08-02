import type { AgentAssessment, AgentImplementationResult, ReviewResult } from "../execution/contracts.js";

export type AgentRole = "implementer" | "internal_reviewer" | "final_reviewer";
export type AgentOutput = AgentAssessment | AgentImplementationResult | ReviewResult;

export interface AgentTurnRequest {
  role: AgentRole;
  model: string;
  reasoning_effort: string;
  thread_id?: string;
  prompt: string;
  read_only: boolean;
  sandbox_mode?: "read-only" | "workspace-write";
  network_access?: false;
  live_web_search?: false;
  cached_web_search?: false;
  signal?: AbortSignal | undefined;
}

export interface AgentTurnResponse {
  thread_id: string;
  output: unknown;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

export interface AgentClient { turn(request: AgentTurnRequest): Promise<AgentTurnResponse>; }
